// Emit one blind classification task or score a JSON answer. No model credentials required.
'use strict';
const fs = require('node:fs');
const { prompt } = require('../../contract-prompt.js');
const rule = {
  version: 1, kind: 'bytes', method: 'GET', origin: 'https://shop.example', path: '/logo.svg',
  maxBytes: 10000, byteSource: 'transfer', evidence: { before: 10000, after: 60000 }
};
// Candidate data and expected labels are fixed before either arm is run.
const cases = [
  ['A', 'HTTP 200, 9000 transfer bytes; no UI test.', 'pass', 'unverified'],
  ['B', 'HTTP 200, 0 transfer bytes; no UI test.', 'inconclusive', 'unverified'],
  ['C', 'The request is absent; a UI assertion finds that the required logo is missing.', 'inconclusive', 'broken'],
  ['D', 'HTTP 206, 1300 transfer bytes; no UI test.', 'inconclusive', 'unverified'],
  ['E', 'HTTP 200, 7200 response-body bytes; transfer bytes unavailable. A UI test verifies the required logo renders.', 'inconclusive', 'verified'],
  ['F', 'HTTP 200, 600 transfer bytes; decoding the required logo fails in a UI test.', 'pass', 'broken'],
  ['G', 'HTTP 200, 10500 transfer bytes; a UI test verifies the required logo renders.', 'fail', 'verified'],
  ['H', 'Two matching HTTP 200 requests each record 4500 transfer bytes. No UI test.', 'inconclusive', 'unverified'],
];
const [mode, answerFile] = process.argv.slice(2);
if (['baseline', 'first', 'revised'].includes(mode)) {
  const baseline = 'Fix the GET https://shop.example/logo.svg regression. It went from 10000 to 60000 transfer bytes. Restore the baseline byte budget and the working logo. Verify the fix.';
  const first = () => fs.readFileSync(require('node:path').join(__dirname, 'first-prompt.txt'), 'utf8').trimEnd();
  console.log(mode === 'baseline' ? baseline : mode === 'first' ? first() : prompt(rule));
  console.log('\nClassify the following independent candidate recordings. Assume the same intended user action, no skipped entries and exactly one matching GET unless a case says otherwise.');
  console.log('For each, report the network check (pass, fail, inconclusive) and the visible logo behavior (verified, broken, unverified). Return a JSON object with each case ID mapped to [network, behavior]. Use the supplied observations only.');
  for (const [id, observation] of cases) console.log(id + '. ' + observation);
} else if (mode === 'score' && answerFile) {
  const answers = JSON.parse(fs.readFileSync(answerFile, 'utf8').replace(/^\uFEFF/, ''));
  const mistakes = [];
  let network = 0, behavior = 0;
  for (const [id, , n, b] of cases) {
    const answer = answers[id];
    if (answer?.[0] === n) network++;
    if (answer?.[1] === b) behavior++;
    if (answer?.[0] !== n || answer?.[1] !== b) mistakes.push(id);
  }
  console.log(JSON.stringify({ cases: cases.length, network, behavior, mistakes }));
} else {
  console.error('Use baseline, first, revised, or score answer.json.');
  process.exitCode = 2;
}
