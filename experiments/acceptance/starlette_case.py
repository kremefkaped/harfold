"""Check Harfold against the real routing regression in fastapi/fastapi#4892."""
import argparse
import hashlib
import json
import multiprocessing
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright
from record import cli

TARGET = "/files:upload_homework"
# PyPI wheel SHA-256 digests. Only the router release changes between servers.
DIGESTS = {
    "0.17.1": "26a18cbda5e6b651c964c12c88b36d9898481cd428ed6e063f5f29c418f73050",
    "0.19.1": "5a60c5c2d051f3a8eb546136aa0c9399773a689595e099e0877704d5888279bf",
    "0.20.2": "99d264fbcc07e4d24e9486f55fe99982b8e3869a94f4e6e2879c79f4a9cc8bcd",
}


def wheel_for(version, local_dir, scratch):
    if local_dir is None:
        subprocess.run([sys.executable, "-m", "pip", "download", "--no-deps", "--only-binary=:all:",
                        "--index-url", "https://pypi.org/simple", "--dest", str(scratch),
                        f"starlette=={version}"], check=True)
    wheel = (local_dir or scratch) / f"starlette-{version}-py3-none-any.whl"
    if hashlib.sha256(wheel.read_bytes()).hexdigest() != DIGESTS[version]:
        raise ValueError(f"Unexpected SHA-256 for {wheel.name}")
    return wheel.resolve()


def serve(wheel, port):
    sys.path.insert(0, str(wheel))
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import HTMLResponse, PlainTextResponse
    from starlette.routing import Route

    async def homepage(_):
        return HTMLResponse('<title>Upload</title><link rel="icon" href="data:,">')

    async def upload(_):
        return PlainTextResponse("uploaded")

    app = Starlette(routes=[Route("/", homepage), Route(TARGET, upload, methods=["POST"])])
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="error", lifespan="off")


def capture(browser, folder, origin, version):
    for trial in range(1, 4):
        har = folder / f"starlette-{version}-run{trial}.har"
        with browser.new_context(record_har_path=har, record_har_content="embed",
                                 service_workers="block") as context:
            page = context.new_page()
            page.goto(origin, timeout=15000)
            page.evaluate("async p => (await fetch(p, {method: 'POST'})).text()", TARGET)


def check_captures(folder, scratch):
    def har(version, trial):
        return folder / f"starlette-{version}-run{trial}.har"

    baseline = har("0.17.1", 1)
    entries = json.loads(baseline.read_text("utf-8"))["log"]["entries"]
    endpoint, = [e["request"]["url"] for e in entries if e["request"]["method"] == "POST"]
    if not endpoint.endswith(TARGET):
        raise AssertionError(f"Unexpected baseline endpoint: {endpoint}")
    origin = endpoint[:-len(TARGET)]
    generated = cli(baseline, har("0.19.1", 1), "--derive", "status", "--method", "POST",
                    "--endpoint", endpoint)
    generated.check_returncode()
    contract = scratch / "status-contract.json"
    contract.write_text(generated.stdout, encoding="utf-8")
    print("Starlette   Trial   GET /   POST   Response    Harfold")
    for version in DIGESTS:
        expected = (404, "Not Found", "fail", 1) if version == "0.19.1" else (200, "uploaded", "pass", 0)
        for trial in range(1, 4):
            path = har(version, trial)
            entries = json.loads(path.read_text("utf-8"))["log"]["entries"]
            control, target = entries
            requests = [(e["request"]["method"], e["request"]["url"]) for e in entries]
            if requests != [("GET", origin + "/"), ("POST", endpoint)] or control["response"]["status"] != 200:
                raise AssertionError(f"Unexpected requests or unhealthy homepage in {path.name}")
            status = target["response"]["status"]
            body = target["response"]["content"]["text"]
            result = cli("--check-contract", contract, path)
            if result.returncode not in (0, 1):
                raise RuntimeError(result.stderr or result.stdout)
            verdict = json.loads(result.stdout)
            actual = status, body, verdict["state"], result.returncode
            if actual != expected or verdict["actual"] != status:
                raise AssertionError(f"{path.name}: expected {expected}, observed {actual}")
            print(f"{version:<11} {trial:<6} 200     {status}    {body:<11} {verdict['state']}")


def run(args, scratch):
    wheels = {v: wheel_for(v, args.wheel_dir, scratch) for v in DIGESTS}
    # Reuse the port to keep the contract's origin stable across releases.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    with sync_playwright() as p:
        with p.chromium.launch(channel=args.channel) as browser:
            print("Chromium", browser.version)
            for version, wheel in wheels.items():
                server = multiprocessing.get_context("spawn").Process(target=serve, args=(wheel, port))
                server.start()
                try:
                    for attempt in range(120):
                        if not server.is_alive():
                            raise RuntimeError(f"Starlette {version} exited before accepting connections")
                        try:
                            with socket.create_connection(("127.0.0.1", port), timeout=.1):
                                break
                        except OSError:
                            time.sleep(.05)
                    else:
                        raise TimeoutError(f"Starlette {version} did not start")
                    capture(browser, scratch, origin, version)
                finally:
                    server.terminate()
                    server.join()
    check_captures(scratch, scratch)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", help="Use an installed browser, e.g. chrome or msedge.")
    parser.add_argument("--wheel-dir", type=Path, help="Read the pinned PyPI wheels from a local directory.")
    with tempfile.TemporaryDirectory(prefix="harfold-starlette-") as tmp:
        run(parser.parse_args(), Path(tmp))
