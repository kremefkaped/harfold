# Can the next recording verify a repair?

A developer has one working recording and one broken recording. Extract a single request-level check, verify that it separates the known recordings, and apply it to a new candidate. An independent browser assertion checks what the user sees. The generated task prompt changes according to the latest observation.

## Browser experiment

Seven fresh Chrome contexts visited a local HTTP server. Each visit produced a HAR through Playwright. Two rules derived from the baseline and regression were applied unchanged to every recording through the public CLI. The browser separately checked that a two-pixel SVG decoded and that the product name appeared on the page.

| Recording | Byte rule | HTTP rule | Icon decoded | Product name appeared |
| --- | --- | --- | --- | --- |
| Baseline | Pass | Pass | Yes | Yes |
| Regression (large icon, API 503) | Fail | Fail | Yes | No |
| Repair | Pass | Pass | Yes | Yes |
| Requests removed | Inconclusive | Inconclusive | No | No |
| Requests duplicated | Inconclusive | Inconclusive | Yes | Yes |
| Partial image response (206) | Inconclusive | Pass | Yes | Yes |
| Invalid image and error JSON, both 200 | Pass | Pass | No | No |

These are controlled scenarios recorded in Chromium 156.0.8078.80. The partial-response fixture returns the entire SVG as a byte range. The broken-content case passes both network rules. A product team needs a functional test appropriate to its own acceptance criterion. The experiment measures verdicts on these inputs. Human time savings and adoption require field measurements.

Run from the repository root with Python, Playwright for Python, and Chrome installed:

```sh
python experiments/acceptance/record.py --channel chrome
```

For Playwright's bundled Chromium, install it via `playwright install chromium` and omit `--channel chrome`. The script creates temporary HARs, runs the Node CLI and checks the recorded outcomes. It uses only a loopback server after dependencies are installed.

## Historical incident

A FastAPI user reported that an upgrade broke a route containing a colon. We ran the same application with three actual Starlette router releases, held the origin and path constant, recorded three requests per release and checked the response payload as well as the HTTP status. [Upstream report](https://github.com/fastapi/fastapi/issues/4892) · [Upstream fix](https://github.com/Kludex/starlette/pull/1675) · [Reproduction](starlette-case.md)

## Prompt experiment

Eight fixed candidate descriptions included missing requests, zero bytes, duplicate matches, a partial response, an incompatible measurement source, and a broken image returning 200. We fixed the two expected labels per case before the first trial. Three fresh agent sessions each saw one prompt and the same cases. Each returned a JSON answer without access to the scorer or other sessions' responses.

| Prompt | Network verdicts correct | Visible behavior verdicts correct |
| --- | ---: | ---: |
| Short repair request | 8/8 | 8/8 |
| First detailed rule | 4/8 | 8/8 |
| Revised rule with an explicit eligibility check | 8/8 | 8/8 |

The first detailed prompt said that removing the request could not pass. It left the distinction between failure and an unusable observation implicit. Its trial classified a missing request, a duplicate, a 206 and a zero-byte response as failures. The revision requires checking whether the observation supports a decision before comparing the number. The short prompt also scored perfectly on this run. This is one session per arm and the revision reused the same cases. It shows a regression and recovery on this set. It does not establish a general improvement in model accuracy.

To repeat, give the output of each of the first three commands to independent sessions of the same model. Score each JSON response with the last command. The saved `answers-*.json` files are the responses from this trial.

```sh
node experiments/acceptance/prompt-eval.js baseline
node experiments/acceptance/prompt-eval.js first
node experiments/acceptance/prompt-eval.js revised
node experiments/acceptance/prompt-eval.js score experiments/acceptance/answers-first.json
```

## Field test

Use a recent incident with one stable endpoint and comparable baseline, regression and candidate recordings. Before trying Harfold, write down how you know the feature works. Record the time to create a reusable acceptance check manually and with Harfold. Across developers, alternate which method is tried first to reduce practice effects. Keep the candidate recording out of rule authoring. Compare both verdicts with the independent functional result and report cases where an investigator still needed to intervene.

The next decision gate is twelve real incidents from at least three independent teams. The proposed threshold for further investment is a 30% reduction in median authoring time, with no increase in false repair claims against those teams’ own acceptance tests. Keep incompatible incidents in the denominator and record why they were unsuitable. [Share an observation without attaching your capture](https://github.com/kremefkaped/harfold/issues/new?template=field-test.yml)
