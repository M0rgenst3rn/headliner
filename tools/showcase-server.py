# Serves the project and stores the images tools/showcase.html POSTs (run from anywhere, then open
# http://127.0.0.1:8766/tools/showcase.html?save=1 – the PNGs land in docs/images).
import http.server, os, urllib.parse
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "images")
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def do_POST(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        name = os.path.basename(q["name"][0])
        n = int(self.headers["Content-Length"])
        with open(os.path.join(OUT, name), "wb") as f: f.write(self.rfile.read(n))
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass
print("http://127.0.0.1:8766/tools/showcase.html?save=1")
http.server.ThreadingHTTPServer(("127.0.0.1", 8766), H).serve_forever()
