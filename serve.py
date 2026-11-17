"""Local server for the booth laptop.

Same as `python -m http.server`, but tells the browser never to cache,
so edits to HTML/CSS/JS show up on a normal refresh.

Usage: python serve.py [port]   (default 8080)
"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    # Fixed types: Windows guesses them from the registry, which differs per laptop,
    # and a wrong type can stop the hand-tracking .wasm/.js files from loading.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".wasm": "application/wasm",
        ".woff2": "font/woff2",
        ".data": "application/octet-stream",
        ".tflite": "application/octet-stream",
        ".binarypb": "application/octet-stream",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    print(f"BudgEx Puzzle-Cam: http://localhost:{port}")
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
