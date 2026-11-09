/* Shared formatting for the browser and the command-line report. */
(function () {
  'use strict';

  function duration(ms) {
    if (ms == null) return '—';
    return Math.abs(ms) < 1000
      ? Math.round(ms) + ' ms'
      : Number((ms / 1000).toFixed(2)) + ' s';
  }

  function size(bytes) {
    if (bytes == null) return '—';
    if (Math.abs(bytes) < 1024) return bytes + ' B';
    if (Math.abs(bytes) < 1024 ** 2) return Number((bytes / 1024).toFixed(1)) + ' KiB';
    return Number((bytes / 1024 ** 2).toFixed(2)) + ' MiB';
  }

  function signed(value, format = String) {
    if (value == null) return '—';
    return (value > 0 ? '+' : value < 0 ? '−' : '') + format(Math.abs(value));
  }

  function sortChanges(rows) {
    const group = row => row.state === 'matched' && row.delta > 0 ? 0
      : row.state === 'added' ? 1 : row.state === 'removed' ? 2 : 3;
    return rows.slice().sort((a, b) => group(a) - group(b)
      || Math.abs(b.delta || 0) - Math.abs(a.delta || 0));
  }

  // Render user-controlled text as literal inline code in a Markdown table.
  function cell(text) {
    const safe = String(text).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\|/g, '%7C');
    const runs = safe.match(/`+/g) || [];
    const fence = '`'.repeat(1 + runs.reduce((max, run) => Math.max(max, run.length), 0));
    return fence + ' ' + safe + ' ' + fence;
  }

  function markdown(before, after, comparison) {
    let lines;
    if (comparison) {
      lines = ['# Harfold comparison', '', '| Metric | Baseline A | Comparison B | Change |',
        '| --- | ---: | ---: | ---: |'];
      for (const [label, field, format, delta] of [
        ['Requests', 'count', String, after.count - before.count],
        ['Capture span', 'duration', duration, comparison.durationDelta],
        ['Response bytes', 'bytes', size, comparison.bytesDelta],
        ['HTTP errors', 'errors', String, after.errors - before.errors],
      ]) {
        lines.push(`| ${label} | ${format(before[field])} | ${format(after[field])} | ${signed(delta, format)} |`);
      }
      lines.push('', '## Request changes', '',
        `Showing up to 25 of ${comparison.rows.length} request pairs, with slower matches first.`, '',
        '| Request | State | Time A | Time B | Change | Size A → B | HTTP A → B |',
        '| --- | --- | ---: | ---: | ---: | --- | --- |');
      for (const row of sortChanges(comparison.rows).slice(0, 25)) {
        const times = [duration(row.before?.time), duration(row.after?.time), signed(row.delta, duration)];
        const bytes = size(row.before?.bytes) + ' → ' + size(row.after?.bytes);
        const status = (row.before?.status ?? '—') + ' → ' + (row.after?.status ?? '—');
        const cells = [cell(row.method + ' ' + row.label), row.state, ...times, bytes, status];
        lines.push('| ' + cells.join(' | ') + ' |');
      }
    } else {
      const capture = before;
      lines = ['# Harfold capture', '', '| Requests | Capture span | Response bytes | HTTP errors |',
        '| ---: | ---: | ---: | ---: |',
        `| ${capture.count} | ${duration(capture.duration)} | ${size(capture.bytes)} | ${capture.errors} |`,
        '', '## Slowest requests', '', `Showing up to 25 of ${capture.count} requests.`, '',
        '| Request | Status | Time | Bytes |', '| --- | ---: | ---: | ---: |'];
      const sorted = capture.requests.slice().sort((a, b) => b.time - a.time);
      for (const req of sorted.slice(0, 25)) {
        lines.push(`| ${cell(req.method + ' ' + req.label)} | ${req.status ?? '—'} | ${duration(req.time)} | ${size(req.bytes)} |`);
      }
    }
    const skipped = (before.skipped || 0) + (after?.skipped || 0);
    if (skipped) lines.push('', `Excluded entries: ${skipped}.`);
    lines.push('', 'Capture span runs from first request start to last finish. A dash means unavailable.',
      'Reports include hostnames and paths. Review them before sharing.', '');
    return lines.join('\n');
  }

  const api = { duration, size, signed, sortChanges, markdown };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.HarfoldReport = api;
})();
