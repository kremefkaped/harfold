#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { parseHar, compareHars } = require('./engine.js');
const { markdown, sortChanges } = require('./report.js');
const { derive, check } = require('./contract.js');
const { prompt } = require('./contract-prompt.js');

const MAX_BYTES = 32 * 1024 * 1024;
const usage = `Usage: node cli.js <before.har> <after.har> [--json] [--max-span-increase <ms>]
       node cli.js <before.har> <after.har> --derive <bytes|status> --endpoint <url> [--method GET]
       node cli.js --check-contract <contract.json> <candidate.har>
       node cli.js --prompt <contract.json> [candidate.har]

Compare two local captures. The default output is a Markdown report.
  --json                    Print summary metrics and all request pairs as JSON.
  --max-span-increase <ms>  Fail if the capture span grows by more than this many milliseconds.
  --derive <bytes|status>   Print a rule that passes the baseline and fails the regression.
  --endpoint <url>          Select one absolute HTTP(S) URL, without credentials, query or fragment.
  --method <method>         Match this HTTP method exactly (default GET).
  --check-contract <file>   Check one new HAR and print its verdict as JSON.
  --prompt <file>           Print a repair task, updated with the candidate verdict if supplied.
  --help                    Show usage.

Exit codes: 0 success, 1 failed rule or exceeded budget, 2 invalid input or arguments, 3 inconclusive rule.
`;

function loadJson(file, type) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Expected a regular file.');
  if (stat.size > MAX_BYTES) throw new Error('The per-file limit is 32 MiB.');
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_BYTES) throw new Error('The per-file limit is 32 MiB.');
  // Windows PowerShell can add a UTF-16 BOM when redirecting a generated contract.
  const bom = bytes.length >= 2 ? bytes.readUInt16BE(0) : 0;
  const encoding = bom === 0xfffe ? 'utf-16le' : bom === 0xfeff ? 'utf-16be' : 'utf-8';
  try {
    return JSON.parse(new TextDecoder(encoding, { fatal: true }).decode(bytes));
  } catch {
    // Parser diagnostics can include private data from malformed files.
    throw new Error('Invalid JSON in ' + type + ' file.');
  }
}

const loadCapture = file => parseHar(loadJson(file, 'HAR'));
const writeJson = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

function summary({ count, duration, bytes, errors, skipped }) {
  return { requests: count, spanMs: duration, bytes, httpErrors: errors, skipped };
}

function observation(request) {
  return request && { timeMs: request.time, bytes: request.bytes, status: request.status };
}

function jsonReport(before, after, comparison) {
  return {
    before: summary(before),
    after: summary(after),
    delta: {
      requests: after.count - before.count, spanMs: comparison.durationDelta,
      bytes: comparison.bytesDelta, httpErrors: after.errors - before.errors
    },
    requests: sortChanges(comparison.rows).map(row => ({
      key: row.key, state: row.state, before: observation(row.before),
      after: observation(row.after), deltaMs: row.delta
    }))
  };
}

function compare(before, after, comparison, values) {
  const limit = values['max-span-increase'];
  if (limit !== undefined && (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(limit) || !Number.isFinite(Number(limit)))) {
    throw new Error('--max-span-increase requires a nonnegative number of milliseconds.');
  }

  if (values.json) writeJson(jsonReport(before, after, comparison));
  else process.stdout.write(markdown(before, after, comparison));
  if (limit !== undefined && comparison.durationDelta > Number(limit)) {
    process.stderr.write(`Capture span increased by ${comparison.durationDelta} ms (budget ${limit} ms).\n`);
    return 1;
  }
  return 0;
}

function selectEndpoint(rows, endpoint, method) {
  // Reject ambiguous input instead of silently discarding a selector supplied by the user.
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('--endpoint requires an absolute HTTP(S) URL.');
  }
  if (!/^https?:\/\//i.test(endpoint) || /[?#\\\s\x00-\x1f\x7f]/.test(endpoint) || url.username || url.password) {
    throw new Error('--endpoint requires an HTTP(S) URL without credentials, whitespace, query or fragment.');
  }
  const matches = rows.filter(row => {
    const request = row.before || row.after;
    return request.method === method && request.origin === url.origin && request.path === url.pathname;
  });
  if (matches.length !== 1) throw new Error('Expected exactly one matching endpoint in the comparison.');
  return matches[0];
}

function main() {
  const textOption = { type: 'string' };
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean' }, 'max-span-increase': textOption,
      derive: textOption, endpoint: textOption, method: textOption,
      'check-contract': textOption, prompt: textOption, help: { type: 'boolean' }
    }
  });
  if (values.help) {
    process.stdout.write(usage);
    return 0;
  }
  const mode = ['derive', 'check-contract', 'prompt'].find(name => name in values) || 'compare';
  const allowed = {
    compare: ['json', 'max-span-increase'], derive: ['derive', 'endpoint', 'method'],
    'check-contract': ['check-contract'], prompt: ['prompt']
  };
  if (Object.keys(values).some(name => !allowed[mode].includes(name))) {
    throw new Error('Incompatible options. See --help.');
  }
  if (mode === 'prompt') {
    if (positionals.length > 1) throw new Error('--prompt takes a contract and optionally one candidate HAR. See --help.');
    const contract = loadJson(values.prompt, 'contract');
    const verdict = positionals.length ? check(contract, loadCapture(positionals[0])) : undefined;
    process.stdout.write(prompt(contract, verdict));
    return 0;
  }
  if (mode === 'check-contract') {
    if (positionals.length !== 1) throw new Error('Provide one candidate HAR. See --help.');
    const result = check(loadJson(values['check-contract'], 'contract'), loadCapture(positionals[0]));
    writeJson(result);
    return { pass: 0, fail: 1, inconclusive: 3 }[result.state];
  }
  if (positionals.length !== 2) throw new Error('Provide a baseline and a comparison HAR file. See --help.');
  const [before, after] = positionals.map(loadCapture);
  const comparison = compareHars(before, after);
  if (mode === 'compare') return compare(before, after, comparison, values);
  if (!['bytes', 'status'].includes(values.derive)) throw new Error('--derive requires bytes or status.');
  const row = selectEndpoint(comparison.rows, values.endpoint, values.method ?? 'GET');
  writeJson(derive(before, after, row, values.derive));
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`harfold: ${error.message}\n`);
  process.exitCode = 2;
}
