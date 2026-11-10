"""Compare HTTP status, transfer size, JSON syntax and the decoded product value."""
import argparse
import gzip
import hashlib
import http.client
import io
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

DIGESTS = {
    "0.22.0": "b5eda991ad5f0ee5d8ce4c4540202a573bb6691ecd0c712262d0bc85cf8f2c50",
    "0.21.0": "0efc058261bbcddeca93cad577efd36d0c8a317e44376bcfc0e097a2b3dc24a7",
}
EXPECTED = {"product": "Mug", "quantity": 2}
PATH = "/data.json"


def get_wheel(version, local, scratch):
    if local is None:
        subprocess.run([sys.executable, "-m", "pip", "download", "--only-binary=:all:", "--no-deps",
                        "--index-url", "https://pypi.org/simple", "--dest", str(scratch),
                        "starlette==" + version], check=True)
    path = (local or scratch) / f"starlette-{version}-py3-none-any.whl"
    if hashlib.sha256(path.read_bytes()).hexdigest() != DIGESTS[version]:
        raise ValueError(f"Checksum mismatch: {path.name}")
    return path.resolve()


def serve(wheel, port):
    sys.path.insert(0, str(wheel))
    import uvicorn
    from starlette.applications import Starlette
    from starlette.middleware.gzip import GZipMiddleware
    from starlette.responses import HTMLResponse, Response
    from starlette.routing import Route

    async def home(_):
        return HTMLResponse('<title>gzip case</title><link rel="icon" href="data:,">')

    async def data(request):
        control = request.headers.get("X-Control", "")
        payload = dict(EXPECTED, product="Cup") if control == "wrong-value" else EXPECTED
        name = "x" * 160 if control == "long-name" else ""
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode="wb", filename=name, mtime=0) as out:
            out.write(json.dumps(payload).encode("utf-8"))
        return Response(buf.getvalue(), media_type="application/json", headers={"Content-Encoding": "gzip"})

    app = Starlette(routes=[Route("/", home), Route(PATH, data)])
    app.add_middleware(GZipMiddleware, minimum_size=1)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="error", lifespan="off")


def native_product_check(port, control):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", PATH, headers={"Accept-Encoding": "gzip", "X-Control": control})
        resp = conn.getresponse()
        assert resp.status == 200 and resp.getheader("Content-Encoding") == "gzip"
        raw = gzip.decompress(resp.read())
        if raw.startswith(b"\x1f\x8b"):
            # Positive identification of this upstream fault.
            assert json.loads(gzip.decompress(raw)) == EXPECTED
            return "double gzip"
        return "correct" if json.loads(raw) == EXPECTED else "wrong value"
    finally:
        conn.close()


def record(browser, port, scratch, case, trial):
    path = scratch / f"{case}-{trial}.har"
    content = "omit" if case == "omitted" else "embed"
    control = case if case in ("long-name", "wrong-value") else ""
    with browser.new_context(record_har_path=path, record_har_content=content, service_workers="block") as ctx:
        page = ctx.new_page()
        home = page.goto(f"http://127.0.0.1:{port}")
        assert home.status == 200
        status, value = page.evaluate("""async ([path, control]) => {
            const r = await fetch(path, {headers: {'X-Control': control}});
            try { return [r.status, await r.json()]; }
            catch (e) { return [r.status, e.name]; }
        }""", [PATH, control])
    native = native_product_check(port, control)
    if case == "broken":
        assert value == "SyntaxError" and native == "double gzip"
    elif case == "wrong-value":
        assert value == dict(EXPECTED, product="Cup") and native == "wrong value"
    else:
        assert value == EXPECTED and native == "correct"
    assert status == 200
    return path, native


def run(args, scratch):
    observations = {}
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    with sync_playwright() as p, p.chromium.launch(channel=args.channel) as browser:
        print("Chromium", browser.version)
        for version in DIGESTS:
            wheel = get_wheel(version, args.wheel_dir, scratch)
            server = multiprocessing.get_context("spawn").Process(target=serve, args=(wheel, port))
            server.start()
            try:
                for _ in range(120):
                    if not server.is_alive():
                        raise RuntimeError(f"Server {version} exited during startup")
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=.1):
                            break
                    except OSError:
                        time.sleep(.05)
                else:
                    raise TimeoutError(f"Server {version} did not start")
                cases = ([("fixed", 3), ("long-name", 3), ("wrong-value", 1), ("omitted", 1)]
                         if version == "0.22.0" else [("broken", 3)])
                for case, count in cases:
                    for trial in range(1, count + 1):
                        observations[case, trial] = record(browser, port, scratch, case, trial)
            finally:
                server.terminate()
                server.join()

    contracts = {}
    pair = [observations[c, 1][0] for c in ("fixed", "broken")]
    for kind in ("status", "bytes", "json"):
        result = cli(*pair, "--derive", kind, "--endpoint", f"http://127.0.0.1:{port}" + PATH)
        if kind == "status":
            assert result.returncode == 2 and "2xx" in result.stderr
            print("Status rule unavailable: both recordings returned HTTP 200.")
            continue
        result.check_returncode()
        contracts[kind] = scratch / (kind + ".json")
        contracts[kind].write_text(result.stdout, encoding="utf-8")

    print("case         trial   bytes   size check    JSON syntax    native content")
    for (case, trial), (path, native) in observations.items():
        outcomes = {}
        for kind, contract in contracts.items():
            result = cli("--check-contract", contract, path)
            verdict = json.loads(result.stdout)
            assert result.returncode == {"pass": 0, "fail": 1, "inconclusive": 3}[verdict["state"]]
            outcomes[kind] = verdict
        size_check, syntax = outcomes["bytes"]["state"], outcomes["json"]["state"]
        assert size_check == ("fail" if case in ("long-name", "broken") else "pass")
        assert syntax == {"broken": "fail", "omitted": "inconclusive"}.get(case, "pass")
        print(f"{case:<12} {trial:<7} {outcomes['bytes']['actual']:<7} {size_check:<13} {syntax:<14} {native}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", help="Use a locally installed Chromium channel, e.g. chrome.")
    parser.add_argument("--wheel-dir", type=Path, help="Use two existing official Starlette wheels.")
    with tempfile.TemporaryDirectory(prefix="harfold-gzip-") as tmp:
        run(parser.parse_args(), Path(tmp))
