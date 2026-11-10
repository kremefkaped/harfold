"""Reduce a TypeScript parse regression across a known-good, affected, and optional fixed esbuild version."""
import argparse
import base64
from collections import Counter
from contextlib import contextmanager
from functools import lru_cache
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import sys
import subprocess
import tarfile
import tempfile
import time
from urllib.request import HTTPRedirectHandler, build_opener

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "CachingDictionary.ts"
DEFAULT_ROLES = {"good": "0.25.6", "bad": "0.25.7", "fixed": "0.25.8"}
REGISTRY = "https://registry.npmjs.org/esbuild-wasm"
SEMVER = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")
MAX_BYTES, MAX_LINES, MAX_TRANSFORMS = 128 * 1024, 256, 4096
KNOWN = {
    "original": "e377d07c160cf1073866be82fd2949976d07a573a905b60c2878396f2ddbab70",
    "exit-only": "eaf22cf0732592c247141cbe61efa11012612f5a3122b9af9bbaf52f5724d194",
    "anchored": "22a148ba76d7efa1ebe63d26fd35d36bccb20c1257cc092937cd99e9709e1b55",
    "interval": "e6395ac96b0b403870849b480b1d2d0e8d3bf336635d431e61643a66e3bc25e3",
}
MEMBERS = ("package/lib/main.js", "package/bin/esbuild", "package/wasm_exec_node.js",
           "package/wasm_exec.js", "package/esbuild.wasm")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def input_lines(file):
    if not file.is_file() or file.suffix.lower() != ".ts":
        raise ValueError("Provide a local, regular UTF-8 .ts file.")
    with file.open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES or b"\0" in data:
        raise ValueError("Input exceeds 128 KiB or contains a NUL byte.")
    # Preserve original bytes while using the JavaScript grammar's physical line boundaries.
    text = data.decode("utf-8")
    parts = re.split(r"(\r\n|[\r\n\u2028\u2029])", text)
    lines = [(parts[i] + parts[i+1]).encode() for i in range(0, len(parts)-1, 2)]
    if parts[-1]:
        lines.append(parts[-1].encode())
    if not 1 <= len(lines) <= MAX_LINES:
        raise ValueError("Input must contain 1 to 256 physical lines.")
    return data, lines


def atomic_write(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
        try:
            f.write(data)
        except BaseException:
            f.close()
            tmp.unlink(missing_ok=True)
            raise
    try:
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Unexpected redirect from the official npm registry.")


def fetch_registry(url, max_bytes):
    with build_opener(NoRedirect()).open(url, timeout=45) as response:
        data = response.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError("npm registry response exceeds the size limit.")
    return data


def resolve_pin(ver, builtins, cache, offline):
    metadata_url = f"{REGISTRY}/{ver}"
    archive_url = f"{REGISTRY}/-/esbuild-wasm-{ver}.tgz"
    path = cache / f"esbuild-wasm-{ver}.pin.json" if cache else None
    metadata_bytes = 0
    if ver in builtins:
        pin, provenance = builtins[ver], "bundled"
    elif path is not None and path.is_file():
        with path.open("rb") as f:
            cached_pin = f.read(8193)
        if len(cached_pin) > 8192:
            raise ValueError(f"Oversized cached pin for {ver}")
        pin, provenance = json.loads(cached_pin), "cache"
    else:
        if offline:
            raise RuntimeError(f"Missing cached npm pin for {ver}; populate this cache online first.")
        data = fetch_registry(metadata_url, 1024 * 1024)
        metadata_bytes = len(data)
        meta = json.loads(data)
        if not isinstance(meta, dict) or (meta.get("name"), meta.get("version")) != ("esbuild-wasm", ver):
            raise ValueError("Registry metadata identity mismatch for " + ver)
        dist = meta.get("dist")
        if not isinstance(dist, dict):
            raise ValueError("Missing npm distribution metadata for " + ver)
        pin = {"version": ver, "url": dist.get("tarball"), "sri": dist.get("integrity")}
        provenance = "registry"
    if not isinstance(pin, dict) or pin.get("version") != ver or pin.get("url") != archive_url:
        raise ValueError("Expected the exact official esbuild-wasm archive URL and version for " + ver)
    sri = pin.get("sri")
    if not isinstance(sri, str) or not re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", sri):
        raise ValueError("Expected one SHA-512 integrity digest for " + ver)
    if path is not None and provenance == "registry":
        atomic_write(path, (json.dumps(pin, indent=2)+"\n").encode())
    return pin, provenance, metadata_bytes


def prepare(scratch, cache, offline, versions):
    acquisition = []
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
    builtins = {p["version"]: p for p in json.loads((ROOT / "packages.json").read_text("utf-8-sig"))}
    for ver in versions:
        m, provenance, metadata_bytes = resolve_pin(ver, builtins, cache, offline)
        file = cache / f"esbuild-wasm-{ver}.tgz" if cache else None
        hit = file is not None and file.exists()
        if hit:
            with file.open("rb") as stream:
                data = stream.read(5_000_001)
        else:
            if offline:
                raise RuntimeError("Missing cached package for " + ver)
            data = fetch_registry(m["url"], 5_000_000)
        sri = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
        if len(data) > 5_000_000 or sri != m["sri"]:
            raise ValueError("SHA-512 or size check failed for " + ver)
        if file and not hit:
            atomic_write(file, data)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as arc:
            manifest_member = arc.getmember("package/package.json")
            if not manifest_member.isfile() or manifest_member.size > 1024 * 1024:
                raise ValueError(f"Unsupported package manifest for {ver}")
            manifest = json.load(arc.extractfile(manifest_member))
            if (manifest["name"], manifest["version"]) != ("esbuild-wasm", ver):
                raise ValueError("Package identity mismatch for " + ver)
            for name in MEMBERS:
                try:
                    member = arc.getmember(name)
                except KeyError:
                    raise ValueError(f"Unsupported esbuild-wasm {ver} layout: missing {name}") from None
                if not member.isfile() or member.size > 32 * 1024 * 1024:
                    raise ValueError(f"Unsupported esbuild-wasm {ver} member: {name}")
                dest = scratch / ver / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(arc.extractfile(member).read())
        acquisition.append({"name": "esbuild-wasm", "version": ver, "sri": sri, "url": m["url"],
                            "metadata_url": f"{REGISTRY}/{ver}", "pin_source": provenance,
                            "archive_bytes": len(data), "metadata_downloaded_bytes": metadata_bytes,
                            "downloaded_bytes": metadata_bytes + (0 if hit else len(data))})
    return acquisition


@contextmanager
def compiler(scratch, lines, counts, sourcefile, versions):
    # Run the verified WASM packages even if the caller configures a native esbuild override.
    environment = os.environ.copy()
    environment.pop("ESBUILD_BINARY_PATH", None)
    environment.pop("NODE_OPTIONS", None)
    proc = subprocess.Popen(["node", str(ROOT / "worker.cjs"), str(scratch), *versions], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True, encoding="utf-8", env=environment)
    def transform(version, ids):
        if sum(counts.values()) >= MAX_TRANSFORMS:
            raise RuntimeError(f"Transform budget of {MAX_TRANSFORMS} reached before completing the audits.")
        src = b"".join(lines[i-1] for i in ids).decode("utf-8")
        proc.stdin.write(json.dumps({"version": version, "source": src, "sourcefile": sourcefile}) + "\n")
        proc.stdin.flush()
        message = proc.stdout.readline()
        if not message:
            raise RuntimeError("Compiler service stopped before reporting a result")
        counts[version] += 1
        return json.loads(message)
    try:
        yield transform
    finally:
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
        try:
            code = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            raise RuntimeError("Compiler service did not close cleanly")
        finally:
            proc.stdout.close()
        if code:
            raise RuntimeError(f"Compiler service exited with status {code}")


def infer_target(original, lines, sourcefile, bad, controls):
    errors = original[bad].get("errors", [])
    if original[bad]["ok"]:
        raise ValueError(f"esbuild {bad} compiled the original input successfully.")
    if len(errors) != 1:
        raise ValueError(f"esbuild {bad} reported {len(errors)} errors; require exactly one located diagnostic.")
    failed_controls = [v for v in controls if not original[v]["ok"]]
    if failed_controls:
        raise ValueError("Control version(s) also failed on the original input: " + ", ".join(failed_controls))
    error = errors[0]
    line, col = error.get("line"), error.get("column")
    if (error.get("file") != sourcefile or not isinstance(line, int) or not 1 <= line <= len(lines)
            or not isinstance(col, int) or not error.get("text")):
        raise ValueError("The diagnostic has no mappable source location.")
    text = lines[line-1].decode().rstrip("\r\n\u2028\u2029")
    if text != error.get("lineText") or not 0 <= col < len(text.encode()):
        raise ValueError("The diagnostic must point inside an identifiable original source line.")
    return {key: error[key] for key in ("text", "file", "line", "column", "lineText")}


def anchored(result, ids, target):
    errors = result.get("errors", [])
    if result["ok"] or len(errors) != 1:
        return False
    error = errors[0]
    line = error.get("line", 0)
    return (error["text"] == target["text"] and error.get("file") == target["file"]
            and 1 <= line <= len(ids) and ids[line-1] == target["line"]
            and error.get("column") == target["column"] and error.get("lineText") == target["lineText"])


def ddmin(ids, keep):
    if not keep(ids) or keep(()):
        raise RuntimeError("Unexpected starting predicate")
    granularity = 2
    while len(ids) > 1:
        n = min(granularity, len(ids))
        cuts = [(i*len(ids)//n, (i+1)*len(ids)//n) for i in range(n)]
        for a, b in cuts:
            if keep(ids[a:b]):
                ids, granularity = ids[a:b], 2
                break
        else:
            for a, b in cuts:
                other = ids[:a] + ids[b:]
                if keep(other):
                    ids, granularity = other, max(2, n-1)
                    break
            else:
                if n == len(ids):
                    break
                granularity = min(2*n, len(ids))
    return ids


def intervals(ids):
    for width in range(len(ids), 0, -1):
        for i in range(len(ids)-width+1):
            yield ids[i:i+width], ids[:i] + ids[i+width:]


def experiment(lines, transform, counts, sourcefile, bundled, roles):
    full = tuple(range(1, len(lines)+1))
    bad = roles["bad"]
    controls = [v for role, v in roles.items() if role != "bad"]
    def observe(ids):
        return {v: transform(v, ids) for v in roles.values()}
    original = observe(full)
    target = infer_target(original, lines, sourcefile, bad, controls)
    if bundled and (target["line"], target["column"], target["text"]) != (67, 15, 'Unexpected ":"'):
        raise RuntimeError("Bundled case diverged from the recorded upstream diagnostic.")
    def matches(results, ids):
        return all(results[v]["ok"] for v in controls) and anchored(results[bad], ids, target)
    def keep(ids):
        return (target["line"] in ids and anchored(transform(bad, ids), ids, target) and
                all(transform(v, ids)["ok"] for v in controls))
    stages = {"original_check": sum(counts.values())}
    def measured(name, fn):
        before = sum(counts.values())
        result = fn()
        stages[name] = sum(counts.values()) - before
        return result
    weak = measured("exit_only_search", lambda: ddmin(full, lru_cache(None)(lambda x: not transform(bad, x)["ok"])))
    strong = measured("anchored_search", lambda: ddmin(full, lru_cache(None)(keep)))

    @lru_cache(maxsize=4096)
    def interval_keep(ids):
        return keep(ids)
    def prune():
        ids = strong
        while True:
            for _, rest in intervals(ids):
                if interval_keep(rest):
                    ids = rest
                    break
            else:
                return ids
    small = measured("interval_search", prune)
    outputs = {}
    for label, ids in (("exit-only", weak), ("anchored", strong), ("interval", small)):
        blob = b"".join(lines[i-1] for i in ids)
        if bundled and sha(blob) != KNOWN[label]:
            raise RuntimeError(f"{label} diverged from the pinned native result")
        obs = measured(label + "_verification", lambda: observe(ids))
        ok = matches(obs, ids)
        if (label == "exit-only" and obs[bad]["ok"]) or (label != "exit-only" and not ok):
            raise RuntimeError(label + " failed its independent final check")
        if bundled and label == "exit-only" and ok:
            raise RuntimeError("Bundled exit-only control unexpectedly retained the target.")
        outputs[label] = {"original_lines": ids, "lines": len(ids), "bytes": len(blob),
                          "sha256": sha(blob), "matches_target_differential": ok, "observations": obs}

    # Independently rerun every selected version, even if a deletion removes the anchor.
    def audit():
        checked = []
        for dropped, rest in intervals(small):
            obs = observe(rest)
            retained = matches(obs, rest)
            if retained:
                raise RuntimeError(f"Interval can still be removed: {dropped}")
            checked.append({"removed_original_lines": dropped, "retains_target": retained})
        return checked
    audited = measured("independent_interval_audit", audit)
    return {"original_observations": original, "target_diagnostic": target, "outputs": outputs, "checked_intervals": audited,
            "transform_calls_by_stage": stages}


def main():
    ap = argparse.ArgumentParser(description=__doc__, epilog=(
        "Default case: 0.25.6 (working), 0.25.7 (one located error), 0.25.8 (working). "
        "For your own input, set --good and --bad. Add --fixed only when available. "
        "Use full stable major.minor.patch versions of esbuild-wasm from the official npm registry. "
        "Non-bundled versions need the supported WASM package layout and an archive up to 5 MB. "
        "Limits: 128 KiB, 256 lines, 4096 compiler calls, 20 seconds per transform. "
        "The compiler transforms one file. It does not resolve imports, type-check or run the program."))
    ap.add_argument("--input", type=Path, help="Your local UTF-8 .ts file. Default: the bundled cspell example.")
    ap.add_argument("--good", help="Known working release for your input.")
    ap.add_argument("--bad", help="Affected release for your input.")
    ap.add_argument("--fixed", help="Optional working release after the regression.")
    ap.add_argument("--cache", type=Path, help="Store archives and first-resolved registry pins. "
                    "Reusing pins trusts this local cache; it is not an independent signature.")
    ap.add_argument("--offline", action="store_true", help="Require cached archives and a cached "
                    "registry pin for each non-bundled version, with no network fallback.")
    ap.add_argument("--out", type=Path, help="Use this new output directory (default: results, then results-2, etc.).")
    args = ap.parse_args()
    if args.offline and not args.cache:
        ap.error("--offline requires --cache")
    start = time.perf_counter()
    bundled = args.input is None
    roles = DEFAULT_ROLES
    if any(v is not None for v in (args.good, args.bad, args.fixed)):
        if bundled or args.good is None or args.bad is None:
            ap.error("Version overrides require --input, --good and --bad; --fixed is optional.")
        roles = {"good": args.good, "bad": args.bad}
        if args.fixed is not None:
            roles["fixed"] = args.fixed
        if any(len(v) > 48 or not SEMVER.fullmatch(v) for v in roles.values()):
            ap.error("Versions must be stable major.minor.patch numbers (up to 48 characters).")
        if len(set(roles.values())) != len(roles):
            ap.error("Supply distinct versions for good, bad and optional fixed.")
    file = SOURCE if bundled else args.input
    original, lines = input_lines(file)
    if bundled and sha(original) != KNOWN["original"]:
        raise ValueError("Source digest differs from the pinned upstream file")
    counts = Counter()
    node_version = subprocess.check_output(["node", "--version"], text=True, timeout=15).strip()
    if args.out is not None and args.out.exists():
        ap.error("--out must name a new directory")
    with tempfile.TemporaryDirectory(prefix="wasm-reduce-") as tmp:
        acquisition = prepare(Path(tmp), args.cache, args.offline, roles.values())
        with compiler(Path(tmp), lines, counts, file.name, roles.values()) as transform:
            receipt = experiment(lines, transform, counts, file.name, bundled, roles)

    # Reserve a new result directory after the reduction and the independent replay succeed.
    if args.out is not None:
        try:
            args.out.mkdir(parents=True, exist_ok=False)
        except FileExistsError:
            ap.error("--out must name a new directory")
    else:
        index = 1
        while True:
            args.out = Path("results" if index == 1 else f"results-{index}")
            try:
                args.out.mkdir()
                break
            except FileExistsError:
                index += 1
    print(f"New run: {args.out}", flush=True)
    for label, r in receipt["outputs"].items():
        atomic_write(args.out / (label + ".ts"), b"".join(lines[i-1] for i in r["original_lines"]))
    if bundled:
        atomic_write(args.out / "LICENSE.cspell", (ROOT / "LICENSE.cspell").read_bytes())
    receipt.update({"case": "evanw/esbuild#4248" if bundled else "local-input", "sourcefile": file.name,
                    "original_sha256": sha(original), "version_roles": roles,
                    "original_lines": len(lines), "original_bytes": len(original),
                    "packages": acquisition, "node": node_version, "python": platform.python_version(),
                    "os": platform.system(), "arch": platform.machine(), "transform_calls_by_version": dict(counts),
                    "total_transform_calls": sum(counts.values()),
                    "downloaded_bytes": sum(m["downloaded_bytes"] for m in acquisition),
                    "wall_seconds": round(time.perf_counter() - start, 3)})
    atomic_write(args.out / "receipt.json", (json.dumps(receipt, indent=2, ensure_ascii=False)+"\n").encode())
    for label, r in receipt["outputs"].items():
        print(f"{label:9}  {r['lines']:2} lines   {r['bytes']:3} bytes   {r['sha256']}")
    print(f"{len(receipt['checked_intervals'])} deletion intervals checked; {receipt['total_transform_calls']} transforms")
    print(f"{receipt['downloaded_bytes']} bytes downloaded; {receipt['wall_seconds']} seconds; {args.out}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError, tarfile.TarError) as error:
        print(f"Insufficient evidence: {error}", file=sys.stderr)
        sys.exit(2)
