# A real routing regression reproduced with three Starlette releases

A FastAPI user reported that upgrading their application made `POST /files:upload_homework` return 404. Their working environment included Starlette 0.17.1 and the broken environment included 0.19.1. Starlette's maintainers traced the regression to path compilation stripping text after a colon and fixed the behavior in 0.20.2. [Original report](https://github.com/fastapi/fastapi/issues/4892) · [Upstream fix and regression test](https://github.com/Kludex/starlette/pull/1675/files) · [Starlette release notes](https://starlette.dev/release-notes/)

## Result

| Starlette | Homepage control | Target POST | Response text | Harfold status check |
| --- | --- | --- | --- | --- |
| 0.17.1, baseline | 200 × 3 | 200 × 3 | `uploaded` | 3 pass, each exit 0 |
| 0.19.1, regression | 200 × 3 | 404 × 3 | `Not Found` | 3 fail, each exit 1 |
| 0.20.2, upstream fix | 200 × 3 | 200 × 3 | `uploaded` | 3 pass, each exit 0 |

The experiment starts the same small application against three checksum-pinned upstream wheels. All releases use the same loopback origin. A fresh browser context records one homepage GET and one empty POST per trial. The handler always returns `uploaded` if the router reaches it.

Harfold derives one 2xx status contract using the first baseline and first regression recordings. The script then checks that contract against all nine HARs. Seven recordings were held out from derivation, including all three from the fixed release. The script also independently checks the exact status and response body saved in each HAR, the healthy homepage and the CLI exit code.

This validates the router behavior in one previously reported incident. The response marker shows that the route reached the handler. The fixture sends an empty POST and performs no file upload, authentication or storage operation.

## Reproduce

From the repository root, with Node.js 22+ and a Python virtual environment active, run:

```sh
python -m pip install "playwright==1.62.0" "uvicorn==0.45.0" "anyio==3.7.1"
python -m playwright install chromium
python experiments/acceptance/starlette_case.py
```

The first run downloads the three small Starlette wheels from PyPI, verifies their SHA-256 digests, records the browser traffic and prints the nine results. The program uses a temporary directory for the wheels, captures and contract. The experiment is optional and adds no dependency to Harfold itself.

Pip reports that PyPI later withdrew 0.20.2 for security. This experiment pins that historical release to exercise the first published fix on a temporary loopback server. [PyPI release record](https://pypi.org/project/starlette/0.20.2/)

To run using installed Google Chrome and a previously downloaded set of official wheels, use the following command. The directory must contain the `starlette-<version>-py3-none-any.whl` file for each of the three releases.

```sh
python experiments/acceptance/starlette_case.py --channel chrome --wheel-dir path/to/wheels
```

The recorded run used Windows, Python 3.13.9, Node.js 24.14.1 and Chrome 156.0.8078.80, with the Python dependency versions shown above.
