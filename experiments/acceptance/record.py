"""Record a local release and its counterexamples in Chromium, then run the shipping CLI.

Optional experiment dependency: pip install playwright && playwright install chromium
Run: python experiments/acceptance/record.py
Use --channel chrome for an installed copy of Chrome. Captures are temporary.
"""
import argparse
import json
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.sax.saxutils import escape

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
# Each tuple describes the expected network check for bytes/status, then the
# independently observed behavior: a decodable icon and the right product name.
CASES = {
    "baseline": ("pass", "pass", True, True),
    "regression": ("fail", "fail", True, False),
    "repair": ("pass", "pass", True, True),
    "removed": ("inconclusive", "inconclusive", False, False),
    "duplicate": ("inconclusive", "inconclusive", True, True),
    "partial": ("inconclusive", "pass", True, True),
    "wrong-content": ("pass", "pass", False, False),
}


class Store(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        mode = self.server.mode
        status = 200
        if path == "/":
            content_type = "text/html"
            body = b"<!doctype html><title>Shop</title><main id='product'></main>"
        elif path == "/icon.svg":
            content_type = "image/svg+xml"
            # The size regression adds harmless metadata to the image.
            padding = "x" * (18000 if mode == "regression" else 700 if mode == "baseline" else 200)
            svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><desc>{escape(padding)}</desc><circle r="1"/></svg>'
            body = b"broken" if mode == "wrong-content" else svg.encode()
            status = 206 if mode == "partial" else 200
        elif path == "/product":
            content_type = "application/json"
            body = b'{"name":"Mug"}'
            if mode in ("regression", "wrong-content"):
                body = b'{"message":"temporarily unavailable"}'
                status = 503 if mode == "regression" else 200
        else:
            content_type, status, body = "text/plain", 404, b"missing"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if status == 206:
            self.send_header("Content-Range", f"bytes 0-{len(body)-1}/{len(body)}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def record(browser, folder, server, origin, mode):
    server.mode = mode
    file = folder / (mode + ".har")
    context = browser.new_context(record_har_path=file, record_har_content="omit")
    try:
        page = context.new_page()
        page.goto(origin)
        return page.evaluate("""async mode => {
          const product = document.querySelector('#product');
          for (let i = 0; i < (mode === 'removed' ? 0 : mode === 'duplicate' ? 2 : 1); i++) {
            const img = document.createElement('img');
            img.src = '/icon.svg?attempt=' + i;
            product.append(img);
            try { await img.decode(); } catch {}
            const response = await fetch('/product?attempt=' + i);
            if (response.ok) product.append((await response.json()).name || '');
          }
          return [product.querySelector('img')?.naturalWidth === 2, product.textContent.includes('Mug')];
        }""", mode)
    finally:
        context.close()


def cli(*args):
    return subprocess.run(["node", str(ROOT / "cli.js"), *map(str, args)], capture_output=True, text=True)


def run(channel, folder):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Store)
    origin = f"http://127.0.0.1:{server.server_port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel=channel)
            observed = {mode: record(browser, folder, server, origin, mode) for mode in CASES}
            print("Chromium " + browser.version)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

    contracts = []
    for kind, path in [("bytes", "/icon.svg"), ("status", "/product")]:
        created = cli(folder / "baseline.har", folder / "regression.har", "--derive", kind, "--endpoint", origin + path)
        if created.returncode:
            raise RuntimeError(created.stderr)
        contract = folder / (kind + ".json")
        contract.write_text(created.stdout, encoding="utf-8")
        contracts.append(contract)

    print("| Recording | Byte check | Status check | Decodable icon | Correct product |")
    print("| --- | --- | --- | --- | --- |")
    for mode, expected in CASES.items():
        results = []
        for contract in contracts:
            result = cli("--check-contract", contract, folder / (mode + ".har"))
            if result.returncode not in (0, 1, 3):
                raise RuntimeError(result.stderr)
            verdict = json.loads(result.stdout)["state"]
            if result.returncode != {"pass": 0, "fail": 1, "inconclusive": 3}[verdict]:
                raise AssertionError("CLI verdict and exit code disagree")
            results.append(verdict)
        actual = (*results, *observed[mode])
        print("| " + " | ".join(map(str, (mode, *actual))) + " |")
        if actual != expected:
            raise AssertionError(f"{mode}: expected {expected}, observed {actual}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", help="Installed Chromium channel, e.g. chrome or msedge.")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="harfold-experiment-") as tmp:
        run(args.channel, Path(tmp))
