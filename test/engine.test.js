"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseHar, compareHars } = require("../engine.js");

function entry(url = "https://example.test/app.js", overrides = {}) {
  return {
    startedDateTime: "2026-01-01T00:00:00.000Z", time: 20,
    request: { method: "GET", url },
    response: { status: 200, _transferSize: 45, content: { mimeType: "text/javascript" } },
    ...overrides,
  };
}

const capture = (...entries) => parseHar({ log: { entries } });

test("waterfall sorts by time, includes gaps and overlaps, and preserves original entry IDs", () => {
  const later = entry(undefined, { startedDateTime: "2026-01-01T00:00:00.010Z", time: 50 });
  const first = entry(undefined, { time: 30 });
  const summary = capture(later, first, first);
  assert.deepEqual(summary.requests.map(r => [r.id, r.index, r.start]), [
    ["r2", 1, 0], ["r3", 2, 0], ["r1", 0, 10],
  ]);
  assert.equal(summary.duration, 60);
  assert.equal(summary.count, 3);
  assert.equal(summary.bytes, 135);
});

test("normalization retains endpoint and method but strips secret URL components and HAR payloads", () => {
  const url = "https://secret-user:secret-pass@Example.Test:443/a%20b?secret-query#secret-fragment";
  const input = entry(url);
  input.request.headers = [{ name: "Authorization", value: "secret-header" }];
  input.request.cookies = [{ name: "sid", value: "secret-cookie" }];
  input.request.postData = { text: "secret-body" };
  input.response.content.text = "secret-response";
  const summary = capture(input);
  const [request] = summary.requests;
  assert.equal(request.host, "example.test");
  assert.equal(request.path, "/a%20b");
  assert.equal(request.origin, "https://example.test");
  assert.equal(request.label, "example.test/a%20b");
  assert.equal(request.type, "script");
  assert.doesNotMatch(JSON.stringify(summary), /secret/);
  assert.doesNotMatch(JSON.stringify(compareHars(summary, summary)), /secret/);
});

test("phase start is relative to the request, TLS is within connect, and exported rounding is clipped", () => {
  const timings = { blocked: -1, dns: 2, connect: 8, ssl: 3, send: 1, wait: 6, receive: 4 };
  const [request] = capture(entry(undefined, { time: 20, timings })).requests;
  assert.deepEqual(request.phases.map(p => [p.name, p.start, p.time]), [
    ["dns", 0, 2], ["connect", 2, 5], ["ssl", 7, 3], ["send", 10, 1],
    ["wait", 11, 6], ["receive", 17, 3],
  ]);
  assert.equal(capture(entry(undefined, { time: -1, timings })).duration, 21);
  assert.deepEqual(capture(entry(undefined, { time: 0, timings })).requests[0].phases, []);
});

test("wire bytes prefer measured zero, then headers and body, then body; decoded size is excluded", () => {
  const responses = [
    { _transferSize: 0, bodySize: 30 }, { _transferSize: -1, transferSize: 9 },
    { headersSize: 5, bodySize: 20 }, { bodySize: 17 }, { bodySize: -1, content: { size: 1000 } },
  ];
  const summary = capture(...responses.map(response => entry(undefined, { response })));
  assert.deepEqual(summary.requests.map(r => [r.bytes, r.byteSource]), [
    [0, "transfer"], [9, "transfer"], [25, "headers+body"], [17, "body"], [null, null],
  ]);
  assert.equal(summary.bytes, null);
  assert.equal(compareHars(summary, capture()).bytesDelta, null);
  assert.equal(capture(entry(undefined, { response: { bodySize: "2" } })).bytes, null);
});

test("counts HTTP errors apart from missing responses and status zero", () => {
  const summary = capture(...[200, 301, 404, 503, 0, null, 42].map(status => entry(undefined, { response: { status } })));
  assert.equal(summary.errors, 2);
  assert.deepEqual(summary.requests.map(r => r.status), [200, 301, 404, 503, 0, null, null]);
});

test("explicit browser resource types win, fallback MIME categories discard arbitrary input", () => {
  const captureType = (mimeType, kind) => capture(entry(undefined, {
    _resourceType: kind, response: { content: { mimeType } },
  })).requests[0].type;
  assert.equal(captureType("text/html", "XHR"), "xhr");
  assert.equal(captureType("text/CSS; charset=utf-8"), "stylesheet");
  assert.equal(captureType("image/avif"), "image");
  assert.equal(captureType("font/woff2"), "font");
  assert.equal(captureType("audio/mp4"), "media");
  assert.equal(captureType("<secret>", "secret"), "other");
});

test("skips unsupported/malformed records, accepts empty captures, and rejects invalid roots or oversized arrays", () => {
  const summary = capture(
    null, entry("data:text/plain,secret"), entry("file:///secret"), entry("https://[invalid"),
    entry(undefined, { startedDateTime: "never" }), entry(undefined, { time: "20" }),
    entry(undefined, { request: { method: {}, url: "https://test.invalid" } }), entry(),
  );
  assert.equal(summary.skipped, 7);
  assert.equal(summary.count, 1);
  assert.deepEqual(capture(), { requests: [], duration: 0, bytes: 0, errors: 0, count: 0, skipped: 0 });
  for (const malformed of [null, [], {}, { log: { entries: "bad" } }]) {
    assert.throws(() => parseHar(malformed), /log\.entries/);
  }
  assert.throws(() => parseHar({ log: { entries: new Array(50001) } }), /50,000/);
});

test("pairs repeated endpoints chronologically and distinguishes scheme, port, path and method", () => {
  const url = "https://example.test/item";
  const later = "2026-01-01T00:00:00.007Z";
  const before = capture(
    entry(url + "?id=2", { startedDateTime: later, time: 10 }),
    entry(url + "?id=1", { time: 8 }),
    entry("http://example.test/item"), entry("https://example.test:8443/item"), entry(url + "/"),
  );
  const after = capture(
    entry(url + "?id=new", { time: 12 }),
    entry(url + "#changed", { startedDateTime: later, time: 6 }),
    entry(undefined, { request: { method: "POST", url } }), entry(url, { startedDateTime: later }),
  );
  const comparison = compareHars(before, after);
  const matches = comparison.rows.filter(r => r.state === "matched");
  assert.deepEqual(matches.map(r => [r.before.id, r.after.id, r.delta]), [
    ["r2", "r1", 4], ["r1", "r2", -4],
  ]);
  assert.equal(comparison.rows.filter(r => r.state === "removed" && r.after === null).length, 3);
  assert.equal(comparison.rows.filter(r => r.state === "added" && r.before === null).length, 2);
  assert.equal(new Set(comparison.rows.map(r => r.key)).size, comparison.rows.length);
  assert.equal(comparison.durationDelta, 7);
  assert.equal(comparison.bytesDelta, -45);
});
