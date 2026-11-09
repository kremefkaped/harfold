(() => {
  'use strict';
  const { parseHar, compareHars } = window.HarfoldEngine;
  const { duration, size, signed, markdown, sortChanges } = window.HarfoldReport;
  const $ = id => document.getElementById(id);
  const batch = 100;
  const fileLimit = 32 * 1024 ** 2;
  const versions = { a: 0, b: 0 };
  let captures = {};
  let active = 'b';
  let view = 'waterfall';
  let demo = true;
  let comparison = null;
  let limit = batch;

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = String(text);
    return el;
  }

  function announce(message) {
    $('notice').textContent = message;
  }

  function setDemo() {
    versions.a++;
    versions.b++;
    captures = {
      a: { name: 'storefront-before.har', data: parseHar(window.HarfoldDemo.before) },
      b: { name: 'storefront-after.har', data: parseHar(window.HarfoldDemo.after) },
    };
    active = 'b';
    demo = true;
    view = 'waterfall';
    resetFilters();
    refreshCaptures();
  }

  function resetFilters() {
    $('search').value = '';
    $('type-filter').value = 'all';
    limit = batch;
  }

  function refreshCaptures() {
    comparison = captures.a && captures.b ? compareHars(captures.a.data, captures.b.data) : null;
    if (comparison) comparison.rows = sortChanges(comparison.rows);
    const types = new Set();
    for (const key of ['a', 'b']) {
      const cap = captures[key];
      $('name-' + key).textContent = cap ? cap.name : 'Choose a HAR file';
      $('name-' + key).title = cap ? cap.name : '';
      $('capture-select').querySelector(`option[value="${key}"]`).disabled = !cap;
      if (cap) for (const req of cap.data.requests) types.add(req.type);
    }
    const filter = $('type-filter');
    const previousType = filter.value;
    filter.replaceChildren(new Option('All types', 'all'));
    for (const type of [...types].sort()) filter.add(new Option(type, type));
    if (types.has(previousType)) filter.value = previousType;
    $('capture-select').value = active;
    document.body.dataset.source = demo ? 'demo' : 'local';
    $('workspace-note').textContent = demo
      ? 'Explore the storefront demo, or drop your own HAR files below.'
      : 'Inspect a request waterfall or compare two HAR captures.';
    render();
  }

  async function importFile(key, file) {
    if (!file) return;
    const version = ++versions[key];
    try {
      if (file.size > fileLimit) throw new Error('Choose a HAR file smaller than or equal to 32 MiB.');
      const source = (await file.text()).replace(/^\uFEFF/, '');
      let raw;
      try { raw = JSON.parse(source); }
      catch { throw new Error('This file is not valid JSON. Export a HAR from the browser’s Network panel.'); }
      const data = parseHar(raw);
      if (version !== versions[key]) return;
      // On the first successful import, clear both examples to avoid mixing captures.
      if (demo) captures = {};
      demo = false;
      captures[key] = { name: file.name, data };
      active = key;
      resetFilters();
      refreshCaptures();
      const excluded = data.skipped ? ` Skipped ${data.skipped} unsupported or incomplete entries.` : '';
      announce(`Loaded ${file.name} into ${key.toUpperCase()} · ${data.count} requests.${excluded}`);
    } catch (error) {
      if (version === versions[key]) announce(`Could not open ${file.name}. ${error.message}`);
    }
  }

  function metrics() {
    const diff = view === 'compare';
    const cap = captures[active]?.data;
    const before = captures.a?.data;
    const after = captures.b?.data;
    const rows = [
      ['requests', 'Requests', 'count', String],
      ['duration', 'Capture span', 'duration', duration],
      ['bytes', 'Response bytes', 'bytes', size],
      ['errors', 'HTTP errors', 'errors', String],
    ];
    for (const [id, label, field, format] of rows) {
      $('label-' + id).textContent = diff ? label + ' · B − A' : label;
      const metric = $('metric-' + id);
      if (!diff) metric.textContent = cap && cap[field] != null ? format(cap[field]) : '—';
      else {
        const delta = before?.[field] != null && after?.[field] != null ? after[field] - before[field] : null;
        metric.textContent = signed(delta, format);
      }
    }
  }

  function matches(req, term, type) {
    return req && (type === 'all' || req.type === type) &&
      (!term || [req.label, req.method, req.status, req.type].join(' ').toLowerCase().includes(term));
  }

  function requestButton(req, open) {
    const button = node('button', 'request-link');
    button.type = 'button';
    button.title = req.method + ' ' + req.label;
    button.setAttribute('aria-label', 'Inspect ' + button.title);
    const dot = node('span', 'resource-dot dot-' + req.type);
    dot.setAttribute('aria-hidden', 'true');
    button.append(dot, node('span', 'request-label', req.path));
    button.addEventListener('click', open);
    return button;
  }

  function requestRow(req, span) {
    const row = node('tr');
    const name = row.insertCell();
    name.append(requestButton(req, () => detail(req)));
    row.append(node('td', 'cell-type', req.type));
    const statusClass = req.status >= 400 ? ' is-error' : !req.status ? ' is-unknown' : '';
    row.insertCell().append(node('span', 'status-code' + statusClass, req.status ?? '—'));
    const cell = row.insertCell();
    cell.className = 'timeline-cell';
    const track = node('div', 'track');
    const bar = node('span', 'bar dot-' + req.type);
    bar.style.left = (span ? Math.min(100, 100 * req.start / span) : 0) + '%';
    bar.style.width = (span ? 100 * req.time / span : 0) + '%';
    track.title = `Starts at ${duration(req.start)}, lasts ${duration(req.time)}`;
    track.append(bar);
    cell.append(track);
    row.append(node('td', 'number-cell', duration(req.time)));
    return row;
  }

  function changeRow(change) {
    const row = node('tr');
    const req = change.after || change.before;
    row.insertCell().append(requestButton(req, () => detail(req, change)));
    row.append(node('td', 'cell-type', change.state),
      node('td', 'number-cell', duration(change.before?.time)),
      node('td', 'number-cell', duration(change.after?.time)),
      node('td', 'number-cell ' + (change.delta > 0 ? 'delta-up' : change.delta < 0 ? 'delta-down' : ''),
        signed(change.delta, duration)));
    return row;
  }

  function table(body, rows, makeRow, empty) {
    const fragment = document.createDocumentFragment();
    for (const item of rows.slice(0, limit)) fragment.append(makeRow(item));
    if (!rows.length) {
      const row = node('tr');
      const cell = node('td', 'empty-cell', empty);
      cell.colSpan = 5;
      row.append(cell);
      fragment.append(row);
    }
    body.replaceChildren(fragment);
  }

  function render() {
    const diff = view === 'compare';
    const cap = captures[active]?.data;
    $('waterfall-panel').hidden = diff;
    $('compare-panel').hidden = !diff;
    $('capture-picker').hidden = diff;
    $('view-waterfall').setAttribute('aria-pressed', String(!diff));
    $('view-compare').setAttribute('aria-pressed', String(diff));
    $('export-report').disabled = diff ? !comparison : !cap;
    metrics();
    const term = $('search').value.trim().toLowerCase();
    const type = $('type-filter').value;
    let rows, total, counter;
    if (diff) {
      const changes = comparison?.rows || [];
      rows = changes.filter(r => matches(r.before, term, type) || matches(r.after, term, type));
      total = changes.length;
      counter = $('compare-count');
      const top = changes.find(r => r.state === 'matched' && r.delta > 0);
      const summary = $('comparison-summary');
      summary.textContent = !comparison ? 'Choose a baseline and a comparison HAR to see what changed.'
        : top ? `Largest slowdown · ${top.method} ${top.label} took ${duration(top.delta)} longer.`
        : 'No matched request took longer in capture B.';
      table($('compare-body'), rows, changeRow, !comparison ? 'Waiting for the second capture.'
        : total ? 'No changes match these filters.' : 'Both captures contain zero HTTP requests.');
    } else {
      const requests = cap?.requests || [];
      rows = requests.filter(r => matches(r, term, type));
      total = requests.length;
      counter = $('result-count');
      const span = cap?.duration || 0;
      $('axis-start').textContent = '0 ms';
      $('axis-mid').textContent = duration(span / 2);
      $('axis-end').textContent = duration(span);
      table($('waterfall-body'), rows, req => requestRow(req, span), total
        ? 'No requests match these filters.' : 'This capture contains zero HTTP requests.');
    }
    const shown = Math.min(limit, rows.length);
    counter.textContent = `${shown} of ${total} ${diff ? 'request pairs' : 'requests'}`;
    const more = $('more-' + view);
    more.hidden = shown >= rows.length;
    more.textContent = `Show ${Math.min(batch, rows.length - shown)} more`;
  }

  function detailsGrid(items) {
    const grid = node('dl', 'detail-grid');
    for (const [key, value] of items) {
      const group = node('div', 'detail-fact');
      group.append(node('dt', '', key), node('dd', '', value ?? '—'));
      grid.append(group);
    }
    return grid;
  }

  function phaseList(req, title) {
    const section = node('section', 'phase-list');
    section.append(node('h3', '', title));
    if (!req.phases.length) section.append(node('p', '', 'No phase timings recorded.'));
    for (const phase of req.phases) {
      const row = node('div', 'phase-row');
      const track = node('div', 'phase-track');
      const bar = node('span', 'phase-bar');
      bar.style.marginLeft = (req.time ? 100 * phase.start / req.time : 0) + '%';
      bar.style.width = (req.time ? 100 * phase.time / req.time : 0) + '%';
      track.append(bar);
      row.append(node('span', 'phase-name', phase.name), track, node('span', 'phase-time', duration(phase.time)));
      section.append(row);
    }
    return section;
  }

  function detail(req, change) {
    $('detail-title').textContent = req.method + ' ' + req.path;
    const content = $('detail-content');
    content.replaceChildren();
    if (change) {
      content.append(detailsGrid([
        ['Origin', req.origin], ['Match', change.state], ['Time A → B', duration(change.before?.time) + ' → ' + duration(change.after?.time)],
        ['Bytes A → B', size(change.before?.bytes) + ' → ' + size(change.after?.bytes)],
        ['Status A → B', (change.before?.status ?? '—') + ' → ' + (change.after?.status ?? '—')],
        ['Time change', signed(change.delta, duration)],
      ]));
      if (change.before) content.append(phaseList(change.before, 'A · Timing breakdown'));
      if (change.after) content.append(phaseList(change.after, 'B · Timing breakdown'));
    } else {
      content.append(detailsGrid([['Origin', req.origin], ['Type', req.type], ['HTTP status', req.status],
        ['Start offset', duration(req.start)], ['Duration', duration(req.time)], ['Response bytes', size(req.bytes)]]),
      phaseList(req, 'Timing breakdown'));
    }
    $('detail').showModal();
  }

  for (const key of ['a', 'b']) {
    const input = $('file-' + key);
    input.addEventListener('change', () => {
      const file = input.files[0];
      input.value = '';
      importFile(key, file);
    });
    const target = $('drop-' + key);
    target.addEventListener('dragover', event => {
      event.preventDefault();
      target.classList.add('drag-over');
    });
    target.addEventListener('dragleave', event => {
      if (!target.contains(event.relatedTarget)) target.classList.remove('drag-over');
    });
    target.addEventListener('drop', event => {
      event.preventDefault();
      target.classList.remove('drag-over');
      if (event.dataTransfer.files.length === 1) importFile(key, event.dataTransfer.files[0]);
      else announce('Drop one HAR file on each capture slot.');
    });
  }
  // Keep accidental drops outside a capture slot from navigating away.
  for (const type of ['dragover', 'drop']) window.addEventListener(type, event => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  for (const mode of ['waterfall', 'compare']) {
    $('view-' + mode).addEventListener('click', () => { view = mode; limit = batch; render(); });
    $('more-' + mode).addEventListener('click', () => { limit += batch; render(); });
  }
  $('capture-select').addEventListener('change', event => { active = event.target.value; limit = batch; render(); });
  $('search').addEventListener('input', () => { limit = batch; render(); });
  $('type-filter').addEventListener('change', () => { limit = batch; render(); });
  $('reset-demo').addEventListener('click', () => { setDemo(); announce('Restored the two sample captures.'); });
  $('export-report').addEventListener('click', () => {
    const diff = view === 'compare';
    const report = diff ? markdown(captures.a.data, captures.b.data, comparison) : markdown(captures[active].data);
    const url = URL.createObjectURL(new Blob([report], { type: 'text/markdown;charset=utf-8' }));
    const link = node('a');
    link.href = url;
    link.download = diff ? 'harfold-comparison.md' : 'harfold-capture.md';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('Exported Markdown with hostnames and paths. Review before sharing.');
  });
  setDemo();
})();
