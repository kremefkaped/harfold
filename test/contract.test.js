"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseHar, compareHars } = require("../engine.js");
const { derive, check, validate } = require("../contract.js");

function entry(bytes, status = 200, url = "https://shop.example/hero.webp", method = "GET") {
  return {
    startedDateTime: "2026-01-01T00:00:00Z", time: 10,
    request: { method, url }, response: { status, _transferSize: bytes },
  };
}
const capture = (...entries) => parseHar({ log: { entries } });
function derivePair(before, after, kind) {
  const row = compareHars(before, after).rows[0];
  return derive(before, after, row, kind);
}
const a = capture(entry(120));
const b = capture(entry(1000));
const bytes = derivePair(a, b, "bytes");
const status = derivePair(a, capture(entry(1000, 503)), "status");

test("generate a byte check from the evidence; apply it to an independent third recording", () => {
  assert.deepEqual(bytes, {
    version: 1, kind: "bytes", method: "GET", origin: "https://shop.example", path: "/hero.webp",
    maxBytes: 120, byteSource: "transfer", evidence: { before: 120, after: 1000 },
  });
  const saved = JSON.parse(JSON.stringify(bytes));
  assert.equal(validate(saved), saved);
  for (const [actual, expected] of [[115, "pass"], [120, "pass"], [121, "fail"], [1000, "fail"]]) {
    const result = check(saved, capture(entry(actual)));
    assert.equal(result.state, expected);
    assert.equal(result.actual, actual);
    assert.ok(result.reason);
  }
});

test("status contracts gate the 2xx range, preserving unavailable and transport-error states", () => {
  assert.deepEqual(status, {
    version: 1, kind: "status", method: "GET", origin: "https://shop.example", path: "/hero.webp",
    evidence: { before: 200, after: 503 },
  });
  for (const [value, expected] of [
    [100, "fail"], [199, "fail"], [200, "pass"], [204, "pass"], [299, "pass"],
    [300, "fail"], [304, "fail"], [404, "fail"], [599, "fail"], [0, "inconclusive"], [null, "inconclusive"],
  ]) {
    const verdict = check(status, capture(entry(null, value)));
    assert.equal(verdict.state, expected);
    assert.equal(verdict.actual, expected === "inconclusive" ? null : value);
  }
});

test("a tiny error page, partial, no-content, redirect, cached or unmeasured response cannot go green", () => {
  for (const e of [entry(10, 404), entry(10, 206), entry(1, 204), entry(3, 304),
    entry(0), entry(-1), entry(2, null)]) {
    const result = check(bytes, capture(e));
    assert.equal(result.state, "inconclusive");
    assert.equal(result.actual, null);
  }
  assert.throws(() => derivePair(capture(entry(0)), b, "bytes"));
  assert.throws(() => derivePair(a, capture(entry(1000, 304)), "bytes"), /200/);
});

test("size sources must match the baseline, including headers+body versus body alone", () => {
  const body = entry();
  body.response.bodySize = 110;
  assert.equal(check(bytes, capture(body)).state, "inconclusive");
  const larger = entry();
  larger.response.bodySize = 200;
  const bodyOnly = derivePair(capture(body), capture(larger), "bytes");
  assert.equal(bodyOnly.byteSource, "body");
  body.response.headersSize = 10;
  assert.equal(check(bodyOnly, capture(body)).state, "inconclusive");
  assert.throws(() => derivePair(capture(body), capture(larger), "bytes"), /byte source/);
  larger.response.headersSize = 5;
  const headersAndBody = derivePair(capture(body), capture(larger), "bytes");
  assert.equal(headersAndBody.byteSource, "headers+body");
  assert.equal(check(headersAndBody, capture(body)).actual, 120);
});

test("match exact normalized method/origin/path and reject missing, incomplete or ambiguous recordings", () => {
  const url = "https://shop.example/hero.webp";
  for (const recording of [
    capture(), capture(entry(120, 200, url + "/")), capture(entry(120, 200, "http://shop.example/hero.webp")),
    capture(entry(120, 200, url, "POST")), capture(entry(120), entry(120, 200, url + "?variant=2")),
    capture(entry(120), null),
  ]) {
    assert.equal(check(bytes, recording).state, "inconclusive");
    assert.equal(check(status, recording).state, "inconclusive");
  }
  assert.throws(() => derivePair(capture(entry(120), entry(110)), b, "bytes"), /more than once/);
  assert.throws(() => derivePair(a, capture(entry(1000), entry(120)), "bytes"), /more than once/);
  assert.throws(() => derivePair(a, capture(entry(1000), null), "bytes"), /incomplete/);
  assert.throws(() => derivePair(capture(), b, "bytes"), /both captures/);
  assert.throws(() => derivePair(a, capture(), "bytes"), /both captures/);
});

test("reject irrelevant metric changes, mismatched rows and fabricated evidence that still crosses the budget", () => {
  assert.throws(() => derivePair(a, a, "bytes"));
  assert.throws(() => derivePair(b, a, "bytes"));
  assert.throws(() => derivePair(a, capture(entry(50, 302)), "status"));
  assert.throws(() => derivePair(capture(entry(50, 400)), capture(entry(9, 500)), "status"));
  assert.throws(() => derivePair(a, b, "time"));
  const row = compareHars(a, b).rows[0];
  assert.throws(() => derive(a, b, { ...row, after: { ...row.after, origin: "https://other.example" } }, "bytes"));
  assert.throws(() => derive(a, b, { ...row, after: { ...row.after, bytes: 999 } }, "bytes"), /differs/);
  assert.throws(() => derive(a, capture(entry(122)), row, "bytes"), /differs/);
});

test("only the normalized endpoint and numeric evidence survive export", () => {
  const original = entry(120, 200, "https://secret-user:secret-pass@SHOP.example:443/a%20b?secret-query#secret-fragment");
  original.request.headers = [{ name: "Authorization", value: "secret-header" }];
  original.request.cookies = [{ name: "session", value: "secret-cookie" }];
  original.request.postData = { text: "secret-request-body" };
  original.response.content = { text: "secret-body" };
  const derived = derivePair(capture(original), capture(entry(150, 200, "https://shop.example/a%20b")), "bytes");
  assert.equal(derived.origin, "https://shop.example");
  assert.equal(derived.path, "/a%20b");
  assert.doesNotMatch(JSON.stringify(derived), /secret/i);
});

test("loading malformed or extended contract JSON fails closed without reflecting private input", () => {
  const proto = JSON.parse('{"__proto__":{"polluted":true}}');
  const invalid = [
    null, [], true, "invalid", { ...bytes, version: 2 }, { ...bytes, kind: "time" },
    { ...bytes, method: "GE T" }, { ...bytes, origin: "https://secret@shop.example" },
    { ...bytes, origin: "data:text/plain,secret" }, { ...bytes, origin: "https://shop.example:443" },
    { ...bytes, origin: "https://shop.example/secret" }, { ...bytes, path: "/foo?secret" },
    { ...bytes, path: "/foo#secret" }, { ...bytes, path: "/foo/../private" },
    { ...bytes, path: "private" }, { ...bytes, maxBytes: 100 }, { ...bytes, byteSource: "uncompressed" },
    { ...bytes, ...proto }, { ...bytes, headers: ["secret"] }, { ...bytes, [Symbol("field")]: true },
    { ...bytes, evidence: { before: 120, after: 1000, ...proto } },
    { ...bytes, evidence: { before: 120, after: 50 } }, { ...bytes, evidence: { before: 120, after: Infinity } },
    { ...status, maxBytes: 120 }, { ...status, evidence: { before: 201, after: 302 } },
    Object.assign(Object.create({ hidden: true }), bytes),
    Object.defineProperty({ ...bytes }, "method", { get() { throw Error("secret getter"); } }),
  ];
  for (const bad of invalid) {
    assert.throws(() => validate(bad), err => !/secret/i.test(err.message));
    assert.throws(() => check(bad, a));
  }
  assert.equal({}.polluted, undefined);
});
