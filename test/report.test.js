'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHar, compareHars } = require('../engine.js');
const { markdown, duration, size, signed } = require('../report.js');
const fs = require('node:fs');
const path = require('node:path');
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/storefront-' + name + '.har'), 'utf8'));

test('both reports use the same capture data and make missing measurements visible', () => {
  const raw = fixture('before');
  raw.log.entries[0].response.bodySize = -1;
  delete raw.log.entries[0].response._transferSize;
  raw.log.entries[0].request.url = 'https://user:password@storefront.example/private|`path?secret=yes#token';
  const a = parseHar(raw);
  const b = parseHar(fixture('after'));
  for (const report of [markdown(a), markdown(a, b, compareHars(a, b))]) {
    assert.match(report, /—/);
    assert.match(report, /private%7C/);
    assert.doesNotMatch(report, /secret=yes|password|#token/);
    assert.match(report, /storefront\.example/);
  }
  assert.equal(signed(null, size), '—');
  assert.equal(signed(-1200, duration), '−1.2 s');
  assert.equal(size(1024), '1 KiB');
  assert.match(markdown(a, b, compareHars(a, b)), /recommendations .*— → 503/);
});
