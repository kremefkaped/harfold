'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const cli = path.join(__dirname, '..', 'cli.js');
const pair = ['before', 'after'].map(slot => path.join(__dirname, '..', 'examples', `storefront-${slot}.har`));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });

test('prints a Markdown comparison or usage', () => {
  const report = run(...pair);
  assert.equal(report.status, 0);
  assert.match(report.stdout, /^# Harfold comparison/);
  assert.match(report.stdout, /hero\.webp/);
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
});

test('JSON contains normalized request changes and decimal millisecond budgets are inclusive', () => {
  const result = run(...pair, '--json', '--max-span-increase', '794');
  assert.equal(result.status, 0);
  const data = JSON.parse(result.stdout);
  assert.equal(data.delta.spanMs, 794);
  assert.equal(data.after.httpErrors, 1);
  assert.equal(data.requests.find(row => row.key.includes('/images/hero.webp')).deltaMs, 1020);
  assert.deepEqual(data.requests.filter(row => row.key.includes('/api/stock')).map(row => row.key).sort(), [
    'GET https://storefront.example/api/stock #1', 'GET https://storefront.example/api/stock #2'
  ]);
  assert.doesNotMatch(result.stdout, /\?item=|queryString|headers|cookies/);

  const failed = run(...pair, '--max-span-increase', '793.99', '--json');
  assert.equal(failed.status, 1);
  assert.deepEqual(JSON.parse(failed.stdout), data);
  assert.match(failed.stderr, /794 ms/);
});

test('rejects invalid input without echoing capture contents', t => {
  for (const args of [[], [...pair, '--unknown'], [...pair, '--max-span-increase=NaN']]) {
    assert.equal(run(...args).status, 2);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harfold-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.har');
  assert.equal(run(pair[0], file).status, 2);
  fs.writeFileSync(file, 'private-token-is-secret');
  const malformed = run(pair[0], file);
  assert.equal(malformed.status, 2);
  assert.equal(malformed.stdout, '');
  assert.match(malformed.stderr, /Invalid JSON/);
  assert.doesNotMatch(malformed.stderr, /private-token/);
  fs.writeFileSync(file, '{}');
  assert.equal(run(pair[0], file).status, 2);
  fs.truncateSync(file, 32 * 1024 * 1024 + 1);
  const oversized = run(pair[0], file);
  assert.equal(oversized.status, 2);
  assert.match(oversized.stderr, /32 MiB/);
});
