'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseHar, compareHars } = require('../engine.js');
const { derive, validate, check } = require('../contract.js');

const limit = 1024 * 1024;
const capture = (...entries) => parseHar({ log: { entries } });
function entry(text, content = {}, response = {}) {
  return {
    request: { method: 'GET', url: 'https://app.example/data?secret-query=1' },
    startedDateTime: '2026-01-01T00:00:00Z', time: 10,
    response: { status: 200, content: { mimeType: 'application/json', text, ...content }, ...response }
  };
}
const state = (...args) => capture(entry(...args)).requests[0].jsonState;
const encoded = text => Buffer.from(text).toString('base64');

test('uses declared JSON media types and retains only a syntax result', () => {
  assert.equal(state('"private value"', { mimeType: 'Application/Problem+JSON; charset=UTF-8' }), 'valid');
  assert.equal(state('null', { mimeType: 'model/gltf+json' }), 'valid');
  assert.equal(state('\uFEFF[1]'), 'valid');
  assert.equal(state('\uFEFF\uFEFF[1]'), 'invalid');
  assert.equal(state(' ', { size: 1 }), 'invalid');
  assert.equal(state('', { size: 0 }), 'invalid');
  for (const mimeType of ['application/jsonp', 'text/plain', 'bad+json', 'application/json+jsonp', null]) {
    assert.equal(state('{}', { mimeType }), null);
  }
  for (const [text, content, response] of [
    [undefined], [null], [''], ['', { size: 30 }], ['{}', { encoding: 'gzip' }], ['{}', { size: 20 }],
    ['{}', { _file: 'body.json' }], ['{}', { _sha1: 'hash' }], ['{}', { truncated: true }],
    ['{}', {}, { _bodyTruncated: true }], ['{}', {}, { status: 206 }]
  ]) assert.equal(state(text, content, response), null);
  const secret = 'private-do-not-report';
  for (const text of [JSON.stringify({ secret }), 'broken{' + secret]) {
    const normalized = capture(entry(text));
    assert.ok(!JSON.stringify(normalized).includes(secret));
    assert.ok(!JSON.stringify(normalized).includes('secret-query'));
  }
});

test('distinguishes malformed HAR base64 from JSON and matches Fetch UTF-8 decoding', async () => {
  const encoding = { encoding: 'base64' };
  assert.equal(state(encoded('\uFEFF{"name":"雪"}'), encoding), 'valid');
  assert.equal(state(encoded(' 42 ').replace(/.{4}/g, '$&\r\n'), encoding), 'valid');
  assert.equal(state(encoded('private{'), encoding), 'invalid');
  assert.equal(state(Buffer.from([0xff, 0xff]).toString('base64'), encoding), 'invalid');
  const nonUtf8String = Buffer.from([34, 255, 34]);
  assert.equal(await new Response(nonUtf8String).json(), '\ufffd');
  assert.equal(state(nonUtf8String.toString('base64'), encoding), 'valid');
  for (const text of ['%%%', 'Zg===', 'A', 'AB==']) assert.equal(state(text, encoding), null);
  assert.equal(state('', { ...encoding, size: 0 }), 'invalid');
});

test('caps both raw UTF-8 and decoded base64 at 1 MiB', () => {
  const exact = '[' + ' '.repeat(limit - 2) + ']';
  assert.equal(state(exact), 'valid');
  assert.equal(state(exact + ' '), null);
  assert.equal(state('"' + '雪'.repeat(Math.ceil(limit / 3)) + '"'), null);
  assert.equal(state(encoded(exact), { encoding: 'base64' }), 'valid');
  assert.equal(state(encoded(exact + ' '), { encoding: 'base64' }), null);
  assert.equal(state('null', { size: limit + 1 }), null);
});

test('validates a JSON contract against both samples, then checks a third recording', () => {
  const before = capture(entry('{"items":[1]}'));
  const after = capture(entry('<private-parse-error>'));
  const row = compareHars(before, after).rows[0];
  const rule = derive(before, after, row, 'json');
  assert.deepEqual(rule, {
    version: 1, kind: 'json', method: 'GET', origin: 'https://app.example', path: '/data',
    evidence: { before: 'valid', after: 'invalid' }
  });
  const loaded = validate(JSON.parse(JSON.stringify(rule)));
  const invalid = check(loaded, after);
  assert.equal(invalid.state, 'fail');
  assert.equal(invalid.actual, 'invalid');
  assert.ok(!JSON.stringify(invalid).includes('private-parse-error'));
  // The rule deliberately only checks syntax. This error document has valid JSON syntax.
  const wrongDocument = check(loaded, capture(entry('{"error":"login expired"}')));
  assert.equal(wrongDocument.state, 'pass');
  assert.equal(wrongDocument.actual, 'valid');
  for (const ambiguous of [capture(), capture(entry('{}'), entry('{}')), capture(entry(undefined)),
    capture(entry('{}', {}, { status: 403 })), capture(entry('{}'), null)]) {
    const verdict = check(loaded, ambiguous);
    assert.equal(verdict.state, 'inconclusive');
    assert.equal(verdict.actual, null);
  }
  assert.throws(() => derive(after, before, compareHars(after, before).rows[0], 'json'));
  assert.throws(() => validate({ ...rule, evidence: { before: 'valid', after: '<private-parse-error>' } }),
    error => !error.message.includes('private-parse-error'));
});
