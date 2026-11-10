# A 200 response that a browser cannot parse

A Starlette user reported that their proxy returned a gzip-encoded response and the framework's GZipMiddleware compressed it a second time. The server still declared a single gzip encoding. Starlette fixed this in 0.22.0 by preserving responses with an existing Content-Encoding header. [User report and fix](https://github.com/Kludex/starlette/pull/1901) · [Merged patch](https://github.com/Kludex/starlette/commit/858629f5188bc79d452600b1eb90eaa0045f6454)

The experiment serves a precompressed product response at `GET /data.json` on loopback. It uses **the fixed 0.22.0 release as the known-good baseline** and the earlier 0.21.0 release as the known-bad comparison. This order lets Harfold derive a rule from a working and a broken capture. The historical release sequence ran from broken to fixed.

## Eleven recorded responses

All eleven target requests returned HTTP 200. The browser fetched the endpoint in a fresh context for each recording. Independently, a Python HTTP client decoded the response once and checked that the JSON equalled `{"product":"Mug","quantity":2}`.

| Capture | Trials | Transfer bytes¹ | Byte rule | HAR JSON syntax | Browser JSON | Native product check |
| --- | ---: | ---: | --- | --- | --- | --- |
| Fixed 0.22.0 | 3 | 201 | pass | pass | Mug | pass |
| Broken 0.21.0 | 3 | 242 | fail | fail | SyntaxError | fail |
| Fixed, longer gzip filename | 3 | 363 | fail | pass | Mug | pass |
| Fixed, wrong product value | 1 | 201 | pass | pass | Cup | fail |
| Fixed, HAR body omitted | 1 | 201 | pass | inconclusive | Mug | pass |

¹ Chromium's recorded response transfer size includes headers. These are observed sizes for this run.

Harfold derived the byte and JSON rules from one fixed capture and one broken capture, then checked them against all eleven. The status rule could not be derived from two successful statuses. In the broken version, one gzip decode still produced bytes beginning with gzip's magic number. Decoding a second time recovered the expected JSON.

The three added controls probe distinct limits. Extending the gzip header's optional original filename changes the transfer size while preserving the product. Changing Mug to Cup keeps valid JSON at the same measured transfer size. Recording with Playwright's `record_har_content="omit"` preserves the working response in the browser but leaves Harfold without a body to inspect. These are controls for one upstream bug.

## Reproduce

From the repository root, with Node.js 22+ and an active Python virtual environment:

```sh
python -m pip install "playwright==1.62.0" "uvicorn==0.45.0" "anyio==4.10.0"
python -m playwright install chromium
python experiments/acceptance/gzip_case.py
```

The script fetches the two official wheels from PyPI, checks their pinned SHA-256 digests and runs each version in its own process on the same local port. Captures and contracts live in a temporary directory. If the wheels and Chrome are already installed locally, run `python experiments/acceptance/gzip_case.py --wheel-dir path/to/wheels --channel chrome` to use them. The recorded run used Windows, Python 3.13.9, Node.js 24.14.1 and Chrome 156.0.8078.80.
