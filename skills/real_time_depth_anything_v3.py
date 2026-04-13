#!/usr/bin/env python3
"""Live DA3: input + depth map + point cloud."""

import os
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

import base64
import threading
import time

import cv2
import numpy as np
import torch
import open3d as o3d
import roslibpy
from PIL import Image

from depth_anything_3.api import DepthAnything3
import struct

def ros_time_now():
    t = time.time()
    return {"sec": int(t), "nanosec": int((t - int(t)) * 1e9)}


def publish_image_bgr(pub, img_bgr, frame_id="main_camera_optical"):
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    msg = {
        "header": {"stamp": ros_time_now(), "frame_id": frame_id},
        "height": rgb.shape[0],
        "width": rgb.shape[1],
        "encoding": "rgb8",
        "is_bigendian": 0,
        "step": rgb.shape[1] * 3,
        "data": base64.b64encode(rgb.tobytes()).decode("ascii"),
    }
    pub.publish(roslibpy.Message(msg))


def publish_depth_32fc1(pub, depth_f32, frame_id="main_camera_optical"):
    depth = depth_f32.astype(np.float32)
    msg = {
        "header": {"stamp": ros_time_now(), "frame_id": frame_id},
        "height": depth.shape[0],
        "width": depth.shape[1],
        "encoding": "32FC1",
        "is_bigendian": 0,
        "step": depth.shape[1] * 4,
        "data": base64.b64encode(depth.tobytes()).decode("ascii"),
    }
    pub.publish(roslibpy.Message(msg))


def publish_pointcloud(pub, pts, colors, frame_id="main_camera_optical"):
    """pts: (N,3) float64, colors: (N,3) float [0..1] or (N,3) uint8."""
    n = pts.shape[0]
    if colors.dtype != np.uint8:
        colors = (colors * 255).astype(np.uint8)
    # XYZ (float32) + RGB packed into float32
    buf = np.zeros(n, dtype=[("x", "f4"), ("y", "f4"), ("z", "f4"), ("rgb", "f4")])
    buf["x"] = pts[:, 0].astype(np.float32)
    buf["y"] = pts[:, 1].astype(np.float32)
    buf["z"] = pts[:, 2].astype(np.float32)
    rgb_packed = (colors[:, 0].astype(np.uint32) << 16) | \
                 (colors[:, 1].astype(np.uint32) << 8)  | \
                  colors[:, 2].astype(np.uint32)
    buf["rgb"] = rgb_packed.view(np.float32)

    msg = {
        "header": {"stamp": ros_time_now(), "frame_id": frame_id},
        "height": 1,
        "width": n,
        "fields": [
            {"name": "x",   "offset": 0,  "datatype": 7, "count": 1},
            {"name": "y",   "offset": 4,  "datatype": 7, "count": 1},
            {"name": "z",   "offset": 8,  "datatype": 7, "count": 1},
            {"name": "rgb", "offset": 12, "datatype": 7, "count": 1},
        ],
        "is_bigendian": False,
        "point_step": 16,
        "row_step": 16 * n,
        "is_dense": True,
        "data": base64.b64encode(buf.tobytes()).decode("ascii"),
    }
    pub.publish(roslibpy.Message(msg))


# ---- Config ----
JETSON_HOST = "192.168.50.2"
JETSON_PORT = 9090
IMG_TOPIC = "/mars/main_camera/left/image_raw"
INFO_TOPIC = "/mars/main_camera/left/camera_info"
THROTTLE_MS = 100

MODEL_ID = "depth-anything/DA3-SMALL"
INFER_SIZE = (384, 288)

intrinsics = {"fx": 197.879, "fy": 262.939, "cx": 323.117, "cy": 235.219}
ROT_X, ROT_Y, ROT_Z = np.pi, 0.0, 0.0

latest_frame = {"img": None, "stamp": 0.0}
lock = threading.Lock()

BAYER_CODES = {
    "bayer_rggb8": cv2.COLOR_BayerRG2BGR,
    "bayer_bggr8": cv2.COLOR_BayerBG2BGR,
    "bayer_gbrg8": cv2.COLOR_BayerGB2BGR,
    "bayer_grbg8": cv2.COLOR_BayerGR2BGR,
}


def decode_image(msg) -> np.ndarray:
    raw = msg["data"]
    data = base64.b64decode(raw) if isinstance(raw, str) else bytes(raw)
    h, w, enc = msg["height"], msg["width"], msg["encoding"]

    if enc in ("rgb8", "bgr8"):
        arr = np.frombuffer(data, dtype=np.uint8).reshape(h, w, 3)
        if enc == "rgb8":
            arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    elif enc == "mono8":
        arr = np.frombuffer(data, dtype=np.uint8).reshape(h, w)
        arr = cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)
    elif enc in BAYER_CODES:
        arr = np.frombuffer(data, dtype=np.uint8).reshape(h, w)
        arr = cv2.cvtColor(arr, BAYER_CODES[enc])
    else:
        raise ValueError(f"Unsupported encoding: {enc}")
    return arr


def image_cb(msg):
    try:
        img = decode_image(msg)
        with lock:
            latest_frame["img"] = img
            latest_frame["stamp"] = time.time()
    except Exception as e:
        print(f"[img] decode error: {e}")


def info_cb(msg):
    K = msg.get("k") or msg.get("K")
    if K is None or len(K) < 9:
        return
    intrinsics.update({"fx": K[0], "fy": K[4], "cx": K[2], "cy": K[5]})


# ---- rosbridge ----
print(f"Connecting to ws://{JETSON_HOST}:{JETSON_PORT} ...")
client = roslibpy.Ros(host=JETSON_HOST, port=JETSON_PORT)
client.run()
if not client.is_connected:
    raise RuntimeError("Could not connect to rosbridge")
print("Connected.")

depth_png_pub = roslibpy.Topic(
    client, "/mac/depth_anything/depth/compressed",
    "sensor_msgs/msg/CompressedImage",
)
depth_png_pub.advertise()

depth_colored_pub = roslibpy.Topic(
    client, "/mac/depth_anything/depth_colored/compressed",
    "sensor_msgs/msg/CompressedImage",
)
depth_colored_pub.advertise()

pc_pub = roslibpy.Topic(
    client, "/mac/depth_anything/points",
    "sensor_msgs/msg/PointCloud2",
)
pc_pub.advertise()

img_sub = roslibpy.Topic(
    client, IMG_TOPIC, "sensor_msgs/msg/Image",
    queue_length=1, throttle_rate=THROTTLE_MS,
)
img_sub.subscribe(image_cb)

info_sub = roslibpy.Topic(
    client, INFO_TOPIC, "sensor_msgs/msg/CameraInfo",
    queue_length=1, throttle_rate=1000,
)
info_sub.subscribe(info_cb)

def publish_compressed(pub, data_bytes, fmt, frame_id="main_camera_optical"):
    msg = {
        "header": {"stamp": ros_time_now(), "frame_id": frame_id},
        "format": fmt,
        "data": list(data_bytes),   # uint8 list — most reliable
    }
    pub.publish(roslibpy.Message(msg))


# ---- DA3 ----
print(f"Loading {MODEL_ID} ...")
device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
model = DepthAnything3.from_pretrained(MODEL_ID).to(device).eval()
print(f"Model loaded on {device}.")


def run_inference(img_bgr: np.ndarray) -> np.ndarray:
    h, w = img_bgr.shape[:2]
    small = cv2.resize(img_bgr, INFER_SIZE, interpolation=cv2.INTER_LINEAR)
    pil = Image.fromarray(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
    try:
        prediction = model.inference([pil])
    except Exception:
        tmp = "/tmp/_live_da3_frame.png"
        cv2.imwrite(tmp, small)
        prediction = model.inference([tmp])
    depth = prediction.depth[0]
    depth = cv2.resize(depth, (w, h), interpolation=cv2.INTER_LINEAR)
    return depth


def colorize_depth(depth: np.ndarray, colormap: int = cv2.COLORMAP_INFERNO) -> np.ndarray:
    """Turn a float depth map into a colorized BGR image."""
    d = depth.copy()
    valid = np.isfinite(d) & (d > 0)
    if not valid.any():
        return np.zeros((*d.shape, 3), dtype=np.uint8)
    d_min, d_max = np.percentile(d[valid], [2, 98])  # robust stretch
    d = np.clip((d - d_min) / max(d_max - d_min, 1e-6), 0, 1)
    d_u8 = (d * 255).astype(np.uint8)
    return cv2.applyColorMap(d_u8, colormap)


def depth_to_points(depth: np.ndarray, img_bgr: np.ndarray):
    h, w = depth.shape
    u, v = np.meshgrid(np.arange(w), np.arange(h))
    z = depth.astype(np.float64)
    mask = z > 0
    fx, fy = intrinsics["fx"], intrinsics["fy"]
    cx, cy = intrinsics["cx"], intrinsics["cy"]
    x = (u[mask] - cx) * z[mask] / fx
    y = (v[mask] - cy) * z[mask] / fy
    pts = np.stack([x, y, z[mask]], axis=-1)
    colors = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)[mask] / 255.0
    return pts, colors


# ---- Viewer ----
vis = o3d.visualization.Visualizer()
vis.create_window("Point Cloud", width=900, height=700, left=900, top=100)
pcd = o3d.geometry.PointCloud()
pcd.points = o3d.utility.Vector3dVector(np.zeros((1, 3)))
vis.add_geometry(pcd)
R_FIXED = o3d.geometry.get_rotation_matrix_from_xyz((ROT_X, ROT_Y, ROT_Z))
view_initialized = False

print("Live. Press 'q' in the image window to quit. 'd' toggles depth display mode.")
last_stamp = 0.0
fps_ema = None
show_mode = "side_by_side"  # "side_by_side" | "depth_only" | "input_only"

try:
    while True:
        with lock:
            img = latest_frame["img"].copy() if latest_frame["img"] is not None else None
            stamp = latest_frame["stamp"]

        vis.poll_events()
        vis.update_renderer()

        if img is None or stamp == last_stamp:
            key = cv2.waitKey(10) & 0xFF
            if key == ord("q"):
                break
            continue
        last_stamp = stamp

        t0 = time.time()
        depth = run_inference(img)
        depth_vis = colorize_depth(depth)

        pts, colors = depth_to_points(depth, img)
        if pts.shape[0] > 0:
            publish_pointcloud(pc_pub, pts, colors)
            pcd.points = o3d.utility.Vector3dVector(pts)
            pcd.colors = o3d.utility.Vector3dVector(colors)
            pcd.rotate(R_FIXED, center=(0, 0, 0))
            vis.update_geometry(pcd)
            if not view_initialized:
                vis.reset_view_point(True)
                view_initialized = True
        # In loop:
        # Colorized depth (JPEG — tiny, 8-bit lossy)
        ok, jpg = cv2.imencode(".jpg", depth_vis, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if ok:
            publish_compressed(depth_colored_pub, jpg.tobytes(), "jpeg")

        # Raw depth preserved (16-bit PNG — lossless, keeps metric values scaled)
        depth_mm = np.clip(depth * 1000.0, 0, 65535).astype(np.uint16)  # meters -> mm
        ok, png = cv2.imencode(".png", depth_mm)
        if ok:
            publish_compressed(depth_png_pub, png.tobytes(), "png")

        dt = time.time() - t0
        fps = 1.0 / dt if dt > 0 else 0.0
        fps_ema = fps if fps_ema is None else 0.9 * fps_ema + 0.1 * fps

        # Build display
        if show_mode == "side_by_side":
            display = np.hstack([img, depth_vis])
        elif show_mode == "depth_only":
            display = depth_vis
        else:
            display = img

        cv2.putText(
            display, f"{fps_ema:.1f} FPS  ({dt*1000:.0f} ms)  [{show_mode}]",
            (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2,
        )
        cv2.imshow("Input + Depth", display)

        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        elif key == ord("d"):
            show_mode = {
                "side_by_side": "depth_only",
                "depth_only": "input_only",
                "input_only": "side_by_side",
            }[show_mode]

except KeyboardInterrupt:
    pass
finally:
    print("Shutting down...")
    img_sub.unsubscribe()
    info_sub.unsubscribe()
    client.terminate()
    depth_png_pub.unadvertise()
    depth_colored_pub.unadvertise()
    pc_pub.unadvertise()
    cv2.destroyAllWindows()
    vis.destroy_window()
