"""Live MJPEG viewer for the latest MARS frame.

Polls /tmp/mars_last_frame.jpg (written by local_brain/server.py on every
pose_image) and streams it as multipart MJPEG so a browser shows a live
feed of MARS's camera.

Usage:
    python3 local_brain/viewer.py
    open http://localhost:8766/
"""

import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn


FRAME_PATH = "/tmp/mars_last_frame.jpg"
PORT = 8766
VIEWER_FPS = 8  # browser-side cap


INDEX_HTML = """<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>MARS camera feed</title>
  <style>
    html, body { margin: 0; padding: 0; background: #111; color: #ccc;
                 font-family: -apple-system, monospace; }
    header { padding: 10px 14px; font-size: 13px; opacity: 0.8;
             display: flex; justify-content: space-between; }
    .stat { color: #6f6; }
    .wrap { display: flex; align-items: center; justify-content: center;
            height: calc(100vh - 40px); }
    img { max-width: 100vw; max-height: 100%; object-fit: contain;
          image-rendering: -webkit-optimize-contrast; }
  </style>
</head>
<body>
  <header>
    <span>MARS camera feed - live via local_brain</span>
    <span class="stat" id="stat">-- fps</span>
  </header>
  <div class="wrap">
    <img id="feed" alt="live feed">
  </div>
  <script>
    const img = document.getElementById('feed');
    const stat = document.getElementById('stat');
    let frames = 0;
    let lastReport = performance.now();

    // Poll /latest.jpg as fast as frames arrive. The cache-buster query
    // param ensures each request actually hits the server instead of
    // being served from the memory cache.
    function tick() {
      const next = new Image();
      next.onload = () => {
        img.src = next.src;
        frames++;
        const now = performance.now();
        if (now - lastReport >= 1000) {
          stat.textContent = frames.toFixed(0) + ' fps';
          frames = 0;
          lastReport = now;
        }
        requestAnimationFrame(tick);
      };
      next.onerror = () => setTimeout(tick, 250);
      next.src = '/latest.jpg?t=' + Date.now();
    }
    tick();
  </script>
</body>
</html>
""".encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep connection open for MJPEG streaming

    def log_message(self, *args, **kwargs):  # silence access log
        return

    def do_HEAD(self):
        # Browsers sometimes preflight with HEAD; answer with the same
        # headers as the GET would use so they don't bail out.
        if self.path in ("/", "/index.html"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(INDEX_HTML)))
            self.end_headers()
            return
        if self.path == "/mjpeg":
            self.send_response(200)
            self.send_header(
                "Content-Type", "multipart/x-mixed-replace; boundary=frame"
            )
            self.send_header("Cache-Control", "no-cache, private")
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(INDEX_HTML)))
            self.end_headers()
            self.wfile.write(INDEX_HTML)
            return

        if self.path == "/mjpeg":
            self._stream_mjpeg()
            return

        if self.path == "/latest.jpg":
            self._serve_latest_still()
            return

        self.send_response(404)
        self.end_headers()

    def _stream_mjpeg(self):
        self.send_response(200)
        self.send_header("Age", "0")
        self.send_header("Cache-Control", "no-cache, private")
        self.send_header("Pragma", "no-cache")
        self.send_header("Connection", "close")
        self.send_header(
            "Content-Type", "multipart/x-mixed-replace; boundary=frame"
        )
        self.end_headers()

        last_mtime = 0.0
        interval = 1.0 / VIEWER_FPS
        try:
            # Emit a first frame immediately (don't wait for mtime change)
            # so the browser gets something to render within the first tick.
            primed = False
            while True:
                try:
                    st = os.stat(FRAME_PATH)
                except FileNotFoundError:
                    time.sleep(0.1)
                    continue

                if primed and st.st_mtime == last_mtime:
                    time.sleep(interval / 2)
                    continue
                last_mtime = st.st_mtime
                primed = True

                try:
                    with open(FRAME_PATH, "rb") as f:
                        data = f.read()
                except OSError:
                    time.sleep(0.05)
                    continue
                if not data:
                    continue

                # No Content-Length in the multipart parts — Safari and some
                # Chrome builds stop reading at the declared length and never
                # pick up the next boundary. Leaving it out forces them to
                # scan for the next `--frame` marker, which works everywhere.
                part = (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n"
                    + data
                    + b"\r\n"
                )
                self.wfile.write(part)
                self.wfile.flush()

                time.sleep(interval)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _serve_latest_still(self):
        try:
            with open(FRAME_PATH, "rb") as f:
                data = f.read()
        except OSError:
            self.send_response(503)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


class ThreadedServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    srv = ThreadedServer(("0.0.0.0", PORT), Handler)
    print(f"viewer: http://localhost:{PORT}/")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
