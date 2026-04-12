"""Real-time YOLO detection panel for MARS.

Shows the live camera feed with bounding boxes drawn for every object YOLO
detects, plus a sidebar listing detections with confidence scores. Optionally
highlights a specific "servo target" if one is active.

Runs as a standalone HTTP server on port 8767. Reads frames from
/tmp/mars_last_frame.jpg (written by server.py on every pose_image).

Usage:
    python3 local_brain/yolo_panel.py
    open http://localhost:8767/

    # With a specific target highlighted:
    python3 local_brain/yolo_panel.py --target "yellow block"
"""

import argparse
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

FRAME_PATH = "/tmp/mars_last_frame.jpg"
PORT = 8767
DETECT_FPS = 3          # how often to run YOLO (per second)
MIN_CONFIDENCE = 0.15   # match visual_servo.py

# Colors for bounding boxes (RGB)
COLORS = [
    (0, 255, 0),    # green
    (255, 165, 0),  # orange
    (0, 200, 255),  # cyan
    (255, 255, 0),  # yellow
    (255, 0, 255),  # magenta
    (100, 255, 100),# light green
    (255, 100, 100),# light red
    (100, 100, 255),# light blue
]
TARGET_COLOR = (255, 0, 0)  # red for the active servo target


# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_annotated_jpeg: bytes = b""
_detections: list[dict] = []
_detect_time_ms: float = 0
_frame_age: str = "no frame"
_servo_target: str | None = None


# ---------------------------------------------------------------------------
# Detection thread
# ---------------------------------------------------------------------------

def _detection_loop(target: str | None):
    global _annotated_jpeg, _detections, _detect_time_ms, _frame_age, _servo_target

    from ultralytics import YOLO

    _servo_target = target

    print("loading YOLO11x (COCO)...")
    coco_model = YOLO("yolo11x.pt")
    print("YOLO11x loaded.")

    world_model = None
    if target:
        print(f"loading YOLO-World for target '{target}'...")
        world_model = YOLO("yolov8x-worldv2.pt")
        world_model.set_classes([target])
        print("YOLO-World loaded.")

    # Try to load a nice font, fall back to default
    font = None
    font_sm = None
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 16)
        font_sm = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 13)
    except Exception:
        try:
            font = ImageFont.truetype("/System/Library/Fonts/SFNSMono.ttf", 16)
            font_sm = ImageFont.truetype("/System/Library/Fonts/SFNSMono.ttf", 13)
        except Exception:
            font = ImageFont.load_default()
            font_sm = font

    last_mtime = 0.0
    interval = 1.0 / DETECT_FPS

    while True:
        try:
            st = os.stat(FRAME_PATH)
        except FileNotFoundError:
            time.sleep(0.2)
            continue

        if st.st_mtime == last_mtime:
            time.sleep(interval / 2)
            continue
        last_mtime = st.st_mtime

        try:
            with open(FRAME_PATH, "rb") as f:
                raw = f.read()
        except OSError:
            time.sleep(0.05)
            continue
        if not raw:
            continue

        img = Image.open(io.BytesIO(raw)).convert("RGB")
        img_w, img_h = img.size
        draw = ImageDraw.Draw(img)

        t0 = time.time()

        # --- Run COCO detection ---
        all_dets = []
        results = coco_model.predict(img, conf=MIN_CONFIDENCE, verbose=False)
        if results and len(results[0].boxes) > 0:
            for i, box in enumerate(results[0].boxes):
                cls_name = results[0].names[int(box.cls[0])]
                conf = float(box.conf[0])
                x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
                all_dets.append({
                    "name": cls_name,
                    "confidence": round(conf, 3),
                    "bbox": [round(x1), round(y1), round(x2), round(y2)],
                    "x_center": round(((x1 + x2) / 2) / img_w, 3),
                    "y_center": round(((y1 + y2) / 2) / img_h, 3),
                    "width_pct": round((x2 - x1) / img_w * 100, 1),
                    "height_pct": round((y2 - y1) / img_h * 100, 1),
                    "model": "YOLO11x",
                })

        # --- Run YOLO-World for the specific target (if set) ---
        if world_model and target:
            w_results = world_model.predict(img, conf=MIN_CONFIDENCE, verbose=False)
            if w_results and len(w_results[0].boxes) > 0:
                for i, box in enumerate(w_results[0].boxes):
                    conf = float(box.conf[0])
                    x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
                    all_dets.append({
                        "name": target,
                        "confidence": round(conf, 3),
                        "bbox": [round(x1), round(y1), round(x2), round(y2)],
                        "x_center": round(((x1 + x2) / 2) / img_w, 3),
                        "y_center": round(((y1 + y2) / 2) / img_h, 3),
                        "width_pct": round((x2 - x1) / img_w * 100, 1),
                        "height_pct": round((y2 - y1) / img_h * 100, 1),
                        "model": "YOLO-World",
                    })

        dt_ms = (time.time() - t0) * 1000

        # --- Draw bounding boxes ---
        color_idx = 0
        for det in all_dets:
            x1, y1, x2, y2 = det["bbox"]
            is_target = (target and det["name"].lower() == target.lower())
            color = TARGET_COLOR if is_target else COLORS[color_idx % len(COLORS)]
            thickness = 3 if is_target else 2

            # Box
            for t_off in range(thickness):
                draw.rectangle(
                    [x1 - t_off, y1 - t_off, x2 + t_off, y2 + t_off],
                    outline=color,
                )

            # Label background
            label = f"{det['name']} {det['confidence']:.0%}"
            if det["model"] == "YOLO-World":
                label += " [W]"
            bbox_text = draw.textbbox((x1, y1 - 20), label, font=font)
            draw.rectangle(
                [bbox_text[0] - 2, bbox_text[1] - 2, bbox_text[2] + 2, bbox_text[3] + 2],
                fill=color,
            )
            draw.text((x1, y1 - 20), label, fill=(0, 0, 0), font=font)

            # Center crosshair
            cx = (x1 + x2) / 2
            cy = (y1 + y2) / 2
            draw.line([(cx - 6, cy), (cx + 6, cy)], fill=color, width=1)
            draw.line([(cx, cy - 6), (cx, cy + 6)], fill=color, width=1)

            if not is_target:
                color_idx += 1

        # --- Draw frame center crosshair ---
        cx, cy = img_w / 2, img_h / 2
        draw.line([(cx - 15, cy), (cx + 15, cy)], fill=(255, 255, 255), width=1)
        draw.line([(cx, cy - 15), (cx, cy + 15)], fill=(255, 255, 255), width=1)

        # --- Draw center tolerance zone ---
        tol = 0.15  # CENTER_TOLERANCE from visual_servo.py
        left_tol = int((0.5 - tol) * img_w)
        right_tol = int((0.5 + tol) * img_w)
        draw.line([(left_tol, 0), (left_tol, img_h)], fill=(255, 255, 255, 80), width=1)
        draw.line([(right_tol, 0), (right_tol, img_h)], fill=(255, 255, 255, 80), width=1)

        # --- HUD overlay ---
        hud_lines = [
            f"YOLO: {len(all_dets)} objects | {dt_ms:.0f}ms",
        ]
        if target:
            target_found = any(d["name"].lower() == target.lower() for d in all_dets)
            hud_lines.append(f"TARGET: {target} {'DETECTED' if target_found else 'NOT FOUND'}")
        hud_y = 8
        for line in hud_lines:
            bbox_text = draw.textbbox((8, hud_y), line, font=font_sm)
            draw.rectangle(
                [bbox_text[0] - 2, bbox_text[1] - 1, bbox_text[2] + 2, bbox_text[3] + 1],
                fill=(0, 0, 0, 180),
            )
            draw.text((8, hud_y), line, fill=(0, 255, 0), font=font_sm)
            hud_y += 18

        # --- Encode annotated frame ---
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        annotated = buf.getvalue()

        # Sort detections by confidence descending
        all_dets.sort(key=lambda d: d["confidence"], reverse=True)

        with _lock:
            _annotated_jpeg = annotated
            _detections = all_dets
            _detect_time_ms = dt_ms
            _frame_age = time.strftime("%H:%M:%S")

        time.sleep(interval)


# ---------------------------------------------------------------------------
# HTML UI
# ---------------------------------------------------------------------------

PAGE_HTML = """<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>MARS YOLO Panel</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; background: #0a0a0a; color: #ddd;
                 font-family: 'Menlo', 'SF Mono', monospace; font-size: 13px; }
    .container { display: flex; height: 100vh; }
    .feed { flex: 1; display: flex; align-items: center; justify-content: center;
            background: #111; position: relative; overflow: hidden; }
    .feed img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .sidebar { width: 340px; background: #151515; border-left: 1px solid #333;
               display: flex; flex-direction: column; overflow: hidden; }
    .sidebar-header { padding: 12px 14px; border-bottom: 1px solid #333;
                      background: #1a1a1a; }
    .sidebar-header h2 { font-size: 14px; color: #6f6; margin-bottom: 4px; }
    .stats { font-size: 11px; color: #888; }
    .stats span { color: #aaa; }
    .target-bar { padding: 8px 14px; background: #1a0000; border-bottom: 1px solid #333;
                  color: #f66; font-size: 12px; display: none; }
    .target-bar.active { display: block; }
    .target-bar .status { font-weight: bold; }
    .target-bar .found { color: #6f6; }
    .target-bar .lost { color: #f66; }
    .det-list { flex: 1; overflow-y: auto; padding: 6px 0; }
    .det-item { padding: 8px 14px; border-bottom: 1px solid #222;
                transition: background 0.15s; }
    .det-item:hover { background: #222; }
    .det-item.is-target { background: #2a1515; border-left: 3px solid #f00; }
    .det-name { font-weight: bold; font-size: 13px; }
    .det-name .model-tag { font-weight: normal; font-size: 10px; color: #888;
                           background: #333; padding: 1px 5px; border-radius: 3px;
                           margin-left: 6px; }
    .det-conf { color: #6f6; font-size: 12px; margin-top: 2px; }
    .det-meta { color: #777; font-size: 11px; margin-top: 2px; }
    .bar { height: 4px; background: #333; border-radius: 2px; margin-top: 4px; }
    .bar-fill { height: 100%; border-radius: 2px; transition: width 0.3s; }
    .empty { padding: 30px 14px; text-align: center; color: #555; }
    @media (max-width: 800px) {
      .container { flex-direction: column; }
      .sidebar { width: 100%; height: 40vh; border-left: none; border-top: 1px solid #333; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="feed">
      <img id="feed" alt="YOLO annotated feed">
    </div>
    <div class="sidebar">
      <div class="sidebar-header">
        <h2>YOLO Detection Panel</h2>
        <div class="stats">
          Objects: <span id="n-objects">0</span> |
          Inference: <span id="inf-time">0</span>ms |
          Updated: <span id="updated">--</span>
        </div>
      </div>
      <div class="target-bar" id="target-bar">
        TARGET: <span id="target-name"></span> &mdash;
        <span class="status" id="target-status"></span>
      </div>
      <div class="det-list" id="det-list">
        <div class="empty">Waiting for detections...</div>
      </div>
    </div>
  </div>
  <script>
    const img = document.getElementById('feed');
    const nObj = document.getElementById('n-objects');
    const infTime = document.getElementById('inf-time');
    const updated = document.getElementById('updated');
    const detList = document.getElementById('det-list');
    const targetBar = document.getElementById('target-bar');
    const targetName = document.getElementById('target-name');
    const targetStatus = document.getElementById('target-status');

    // Poll annotated frame
    function pollFrame() {
      const next = new Image();
      next.onload = () => {
        img.src = next.src;
        setTimeout(pollFrame, 200);
      };
      next.onerror = () => setTimeout(pollFrame, 500);
      next.src = '/annotated.jpg?t=' + Date.now();
    }
    pollFrame();

    // Poll detections JSON
    function pollDetections() {
      fetch('/detections.json?t=' + Date.now())
        .then(r => r.json())
        .then(data => {
          nObj.textContent = data.detections.length;
          infTime.textContent = data.detect_time_ms.toFixed(0);
          updated.textContent = data.frame_time;

          const target = data.servo_target;
          if (target) {
            targetBar.classList.add('active');
            targetName.textContent = target;
            const found = data.detections.some(
              d => d.name.toLowerCase() === target.toLowerCase()
            );
            targetStatus.textContent = found ? 'DETECTED' : 'NOT FOUND';
            targetStatus.className = 'status ' + (found ? 'found' : 'lost');
          } else {
            targetBar.classList.remove('active');
          }

          if (data.detections.length === 0) {
            detList.innerHTML = '<div class="empty">No objects detected</div>';
          } else {
            let html = '';
            for (const d of data.detections) {
              const isTarget = target && d.name.toLowerCase() === target.toLowerCase();
              const pct = (d.confidence * 100).toFixed(1);
              const barColor = isTarget ? '#f00' : (d.confidence > 0.5 ? '#6f6' : '#fa0');
              html += `
                <div class="det-item ${isTarget ? 'is-target' : ''}">
                  <div class="det-name">${d.name}
                    <span class="model-tag">${d.model}</span>
                  </div>
                  <div class="det-conf">${pct}% confidence</div>
                  <div class="det-meta">
                    center: (${d.x_center}, ${d.y_center}) |
                    size: ${d.width_pct}% x ${d.height_pct}%
                  </div>
                  <div class="bar">
                    <div class="bar-fill" style="width:${pct}%; background:${barColor}"></div>
                  </div>
                </div>`;
            }
            detList.innerHTML = html;
          }

          setTimeout(pollDetections, 300);
        })
        .catch(() => setTimeout(pollDetections, 1000));
    }
    pollDetections();
  </script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args, **kwargs):
        return

    def do_GET(self):
        path = self.path.split("?")[0]

        if path in ("/", "/index.html"):
            body = PAGE_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/annotated.jpg":
            with _lock:
                data = _annotated_jpeg
            if not data:
                self.send_response(503)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return

        if path == "/detections.json":
            with _lock:
                body = json.dumps({
                    "detections": _detections,
                    "detect_time_ms": _detect_time_ms,
                    "frame_time": _frame_age,
                    "servo_target": _servo_target,
                }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.end_headers()


class ThreadedServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="MARS YOLO detection panel")
    parser.add_argument("--target", type=str, default=None,
                        help="Highlight a specific target (e.g. 'yellow block')")
    parser.add_argument("--port", type=int, default=PORT,
                        help=f"HTTP port (default {PORT})")
    args = parser.parse_args()

    # Start detection thread
    det_thread = threading.Thread(
        target=_detection_loop, args=(args.target,), daemon=True,
    )
    det_thread.start()

    srv = ThreadedServer(("0.0.0.0", args.port), Handler)
    print(f"YOLO panel: http://localhost:{args.port}/")
    if args.target:
        print(f"Servo target: '{args.target}' (highlighted in red)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
