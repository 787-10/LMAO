#!/usr/bin/env python3
"""View input image and point cloud side by side with fixed orientation."""

import sys
from pathlib import Path
import cv2
import numpy as np
import open3d as o3d

OUTPUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("pointcloud_output")
frames_dir = OUTPUT_DIR / "frames"

frame_files = sorted(frames_dir.glob("frame_*.png"))
cloud_files = sorted(OUTPUT_DIR.glob("cloud_*.ply"))

n = min(len(frame_files), len(cloud_files))
if n == 0:
    print("No frames/clouds found.")
    sys.exit(1)

# -- Fixed rotation (edit these angles in radians) --
# Rotation order: X, Y, Z (applied to every point cloud)
ROT_X = np.pi       # 180° — flip so camera up = world up
ROT_Y = 0.0         # set this if you want to rotate around Y
ROT_Z = 0.0

R = o3d.geometry.get_rotation_matrix_from_xyz((ROT_X, ROT_Y, ROT_Z))

print(f"Found {n} frames. Controls:")
print("  n / right arrow = next   p / left arrow = prev")
print("  y / Y = rotate Y -/+   x / X = rotate X -/+   z / Z = rotate Z -/+")
print("  r = reset rotation      q / esc = quit")

idx = 0
rot_x, rot_y, rot_z = ROT_X, ROT_Y, ROT_Z


def make_rotation():
    return o3d.geometry.get_rotation_matrix_from_xyz((rot_x, rot_y, rot_z))


vis = o3d.visualization.Visualizer()
vis.create_window(window_name="Point Cloud", width=800, height=600, left=700, top=100)

pcd = o3d.geometry.PointCloud()


def load_cloud(i):
    raw = o3d.io.read_point_cloud(str(cloud_files[i]))
    raw.rotate(make_rotation(), center=(0, 0, 0))
    return raw


pcd_init = load_cloud(0)
pcd.points = pcd_init.points
pcd.colors = pcd_init.colors
vis.add_geometry(pcd)


def show(i, reset_view=True):
    img = cv2.imread(str(frame_files[i]))
    cv2.imshow("Input Image", img)

    new_pcd = load_cloud(i)
    pcd.points = new_pcd.points
    pcd.colors = new_pcd.colors
    vis.update_geometry(pcd)
    if reset_view:
        vis.reset_view_point(True)
    vis.poll_events()
    vis.update_renderer()

    print(f"  Frame {i}/{n-1}  rot=({rot_x:.2f}, {rot_y:.2f}, {rot_z:.2f})")


show(idx)

STEP = np.pi / 12  # 15° per key press

while True:
    vis.poll_events()
    vis.update_renderer()

    key = cv2.waitKey(30) & 0xFF
    if key == 255:
        continue
    if key in (ord("q"), 27):
        break
    elif key in (ord("n"), 83, 3):
        idx = min(idx + 1, n - 1)
        show(idx)
    elif key in (ord("p"), 81, 2):
        idx = max(idx - 1, 0)
        show(idx)
    elif key == ord("y"):
        rot_y -= STEP; show(idx, reset_view=False)
    elif key == ord("Y"):
        rot_y += STEP; show(idx, reset_view=False)
    elif key == ord("x"):
        rot_x -= STEP; show(idx, reset_view=False)
    elif key == ord("X"):
        rot_x += STEP; show(idx, reset_view=False)
    elif key == ord("z"):
        rot_z -= STEP; show(idx, reset_view=False)
    elif key == ord("Z"):
        rot_z += STEP; show(idx, reset_view=False)
    elif key == ord("r"):
        rot_x, rot_y, rot_z = ROT_X, ROT_Y, ROT_Z
        show(idx, reset_view=False)

cv2.destroyAllWindows()
vis.destroy_window()
