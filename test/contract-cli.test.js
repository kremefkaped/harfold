'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const cli = path.join(__dirname, '..', 'cli.js');
const demo = require('../demo.js');
const endpoint = 'https://storefront.example/images/hero.webp';
const examples = ['before', 'after'].map(slot => path.join(__dirname, '..', 'examples', `storefront-${slot}.har`));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });

function filesFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harfold-rule-'));
  t.after(() => {
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  return (name, data, encoding = 'utf8') => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, data, encoding);
    return file;
  };
}

test('derives, copies, and rechecks the same byte rule, including PowerShell redirection', t => {
  const save = filesFor(t);
  const result = run(...examples, '--derive', 'bytes', '--endpoint', endpoint);
  assert.equal(result.status, 0, result.stderr);
  const rule = JSON.parse(result.stdout);
  assert.equal(rule.maxBytes, 142000);
  assert.equal(rule.byteSource, 'transfer');
  assert.deepEqual(rule.evidence, { before: 142000, after: 1284000 });
  const file = save('rule.json', '\uFEFF' + result.stdout, 'utf16le');
  for (const [capture, expectedCode, expectedState] of [[examples[0], 0, 'pass'], [examples[1], 1, 'fail']]) {
    const verdict = run('--check-contract', file, capture);
    assert.equal(verdict.status, expectedCode, verdict.stderr);
    assert.equal(JSON.parse(verdict.stdout).state, expectedState);
    const updated = run('--prompt', file, capture);
    assert.equal(updated.status, 0, updated.stderr);
    const candidate = JSON.parse(updated.stdout.match(/```json\n(.*?)\n```/s)[1]);
    assert.deepEqual(candidate, JSON.parse(verdict.stdout));
    assert.match(updated.stdout, expectedCode === 0 ? /Verify the expected content/ : /revise the implementation/);
  }
  const task = run('--prompt', file);
  assert.equal(task.status, 0, task.stderr);
  for (const text of ['142000', '1284000', '/images/hero.webp', 'functional test', 'independent experiment',
    'node cli.js --check-contract contract.json candidate.har']) {
    assert.ok(task.stdout.includes(text));
  }
  const hero = demo.before.log.entries.find(entry => entry.request.url === endpoint);
  for (const entries of [[], [hero, hero]]) {
    const candidate = save('candidate.har', JSON.stringify({ log: { entries } }));
    const verdict = run('--check-contract', file, candidate);
    assert.equal(verdict.status, 3, verdict.stderr);
    assert.equal(JSON.parse(verdict.stdout).state, 'inconclusive');
    const updated = run('--prompt', file, candidate);
    assert.equal(updated.status, 0, updated.stderr);
    assert.match(updated.stdout, /Resolve the recording or matching problem first/);
    assert.match(updated.stdout, /"actual": "unavailable"/);
    assert.ok(updated.stdout.includes(JSON.parse(verdict.stdout).reason));
  }
});

test('derives a status contract, quotes an untrusted method, and rejects an ambiguous selector', t => {
  const save = filesFor(t);
  const method = 'GET' + String.fromCharCode(96).repeat(3);
  const files = [200, 503].map(status => {
    const entry = structuredClone(demo.before.log.entries[0]);
    Object.assign(entry.request, { url: endpoint + '?private-query=secret', method });
    entry.response.status = status;
    return save(status + '.har', JSON.stringify({ log: { entries: [entry] } }));
  });
  const derived = run(...files, '--derive', 'status', '--endpoint', endpoint, '--method', method);
  assert.equal(derived.status, 0, derived.stderr);
  assert.doesNotMatch(derived.stdout, /private-query|secret/);
  const file = save('status.json', derived.stdout);
  const task = run('--prompt', file);
  assert.equal(task.status, 0, task.stderr);
  assert.match(task.stdout, /200 to 299/);
  assert.ok(!task.stdout.includes(method));
  assert.match(task.stdout, /\\u0060/);
  const verdict = run('--check-contract', file, files[1]);
  assert.equal(verdict.status, 1, verdict.stderr);
  assert.equal(JSON.parse(verdict.stdout).actual, 503);
  for (const args of [
    [...examples, '--derive', 'bytes', '--endpoint', 'https://storefront.example/api/stock'],
    [...files, '--derive', 'status', '--endpoint', endpoint + '?private-query=secret', '--method', method],
    [...files, '--derive', 'status', '--endpoint', endpoint, '--json'],
    ['--prompt', files[0]],
    ['--check-contract', files[0], files[1]]
  ]) {
    const invalid = run(...args);
    assert.equal(invalid.status, 2, invalid.stderr);
    assert.equal(invalid.stdout, '');
    assert.doesNotMatch(invalid.stderr, /private-query|secret/);
  }
});
