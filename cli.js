#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { parseHar, compareHars } = require('./engine.js');
const { markdown, sortChanges } = require('./report.js');

const MAX_BYTES = 32 * 1024 * 1024;
const usage = `Usage: node cli.js <before.har> <after.har> [--json] [--max-span-increase <ms>]

Compare two local captures. The default output is a Markdown report.
  --json                    Print summary metrics and all request pairs as JSON.
  --max-span-increase <ms>  Fail if the capture span grows by more than this many milliseconds.
  --help                    Show usage.

Exit codes: 0 success, 1 exceeded budget, 2 invalid input or arguments.
`;

function loadCapture(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Expected a regular HAR file.');
  if (stat.size > MAX_BYTES) throw new Error('The per-file limit is 32 MiB.');
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_BYTES) throw new Error('The per-file limit is 32 MiB.');
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    // JSON.parse errors can quote private data from malformed captures.
    throw new Error('Invalid JSON in HAR file.');
  }
  return parseHar(data);
}

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

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { json: { type: 'boolean' }, 'max-span-increase': { type: 'string' }, help: { type: 'boolean' } }
  });
  if (values.help) {
    process.stdout.write(usage);
    return 0;
  }
  if (positionals.length !== 2) throw new Error('Provide a baseline and a comparison HAR file. See --help.');
  const limit = values['max-span-increase'];
  if (limit !== undefined && (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(limit) || !Number.isFinite(Number(limit)))) {
    throw new Error('--max-span-increase requires a nonnegative number of milliseconds.');
  }

  const [before, after] = positionals.map(loadCapture);
  const comparison = compareHars(before, after);
  const report = values.json
    ? JSON.stringify(jsonReport(before, after, comparison), null, 2) + '\n'
    : markdown(before, after, comparison);
  process.stdout.write(report);
  if (limit !== undefined && comparison.durationDelta > Number(limit)) {
    process.stderr.write(`Capture span increased by ${comparison.durationDelta} ms (budget ${limit} ms).\n`);
    return 1;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`harfold: ${error.message}\n`);
  process.exitCode = 2;
}
