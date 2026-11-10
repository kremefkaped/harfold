(() => {
  'use strict';
  const { parseHar, compareHars } = window.HarfoldEngine;
  const { duration, size, signed, markdown, sortChanges } = window.HarfoldReport;
  const $ = id => document.getElementById(id);
  const batch = 100;
  const fileLimit = 32 * 1024 ** 2;
  const versions = { a: 0, b: 0 };
  const demoCaptures = {
    a: { name: 'storefront-before.har', data: parseHar(window.HarfoldDemo.before) },
    b: { name: 'storefront-after.har', data: parseHar(window.HarfoldDemo.after) },
  };
  let captures = {};
  let active = 'b';
  let view = 'waterfall';
  let demo = true;
  let comparison = null;
  let limit = batch;
  let currentCheck = null;
  let checkVersion = 0;
  let candidateVersion = 0;
  let candidateVerdict = null;

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = String(text);
    return el;
  }

  function announce(message) {
    $('notice').textContent = message;
  }

  async function readJson(file, description) {
    if (file.size > fileLimit) throw new Error('Choose a file smaller than or equal to 32 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let encoding = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    try { return JSON.parse(new TextDecoder(encoding, { fatal: true }).decode(bytes)); }
    catch { throw new Error(description); }
  }

  function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = node('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function setDemo() {
    versions.a++;
    versions.b++;
    captures = demoCaptures;
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
    if ($('detail').open) $('detail').close();
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
      const raw = await readJson(file, 'This file is not valid JSON. Export a HAR from the browser’s Network panel.');
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

  function checkCreator(change) {
    const group = node('section', 'check-creator');
    const options = new Map();
    const unavailable = [];
    const ruleNames = { bytes: 'Response byte budget', status: 'Successful HTTP status', json: 'Recorded JSON syntax' };
    for (const kind of Object.keys(ruleNames)) {
      try {
        options.set(kind, window.HarfoldContract.derive(captures.a.data, captures.b.data, change, kind));
      } catch (error) {
        unavailable.push(error.message);
      }
    }
    if (!options.size) {
      const explanation = node('details', 'check-unavailable');
      explanation.append(node('summary', '', 'Why is an acceptance check unavailable?'));
      for (const reason of new Set(unavailable)) explanation.append(node('p', '', reason));
      group.append(explanation);
      return group;
    }
    const select = node('select');
    select.setAttribute('aria-label', 'Acceptance rule');
    for (const kind of options.keys()) {
      select.add(new Option(ruleNames[kind], kind));
    }
    const button = node('button', 'button button-primary', 'Create acceptance check');
    button.type = 'button';
    button.addEventListener('click', () => {
      setCheck(options.get(select.value), 'Verified against captures A and B', demo);
      $('detail').close();
      $('check-dialog').showModal();
    });
    group.append(select, button);
    return group;
  }

  function measuredValue(kind, value) {
    if (kind === 'json') return value === 'valid' ? 'Valid JSON' : 'Invalid JSON';
    return kind === 'bytes' ? value.toLocaleString('en-US') + ' B' : 'HTTP ' + value;
  }

  function resetBehavior() {
    candidateVerdict = null;
    $('behavior-field').hidden = true;
    $('candidate-behavior').value = '';
    $('behavior-assessment').textContent = '';
  }

  function showCheckDemo() {
    const { a, b } = demoCaptures;
    const rows = demo ? comparison.rows : compareHars(a.data, b.data).rows;
    const hero = rows.find(row => row.before?.origin === 'https://storefront.example' && row.before.path === '/images/hero.webp');
    setCheck(window.HarfoldContract.derive(a.data, b.data, hero, 'bytes'), 'Storefront demo · Verified against A and B', true);
    if (!$('check-dialog').open) $('check-dialog').showModal();
  }

  function showJsonDemo() {
    const good = parseHar(window.HarfoldGzipDemo.good);
    const bad = parseHar(window.HarfoldGzipDemo.bad);
    const row = compareHars(good, bad).rows.find(r => r.before?.jsonState === 'valid' && r.after?.jsonState === 'invalid');
    const rule = window.HarfoldContract.derive(good, bad, row, 'json');
    setCheck(rule, 'Starlette #1901 · Gzip case experiment');
    $('case-replay').hidden = false;
    $('case-sample').value = 'bad';
    runCaseSample();
    if (!$('check-dialog').open) $('check-dialog').showModal();
  }

  function runCaseSample() {
    if ($('case-replay').hidden || !currentCheck) return;
    candidateVersion++;
    const option = $('case-sample').selectedOptions[0];
    const source = option.value === 'wrong' ? 'Additional value experiment' : 'Gzip case experiment';
    const name = option.text;
    const observation = {
      good: 'The independent client decoded the expected product Mug, quantity 2.',
      bad: 'After one gzip decode, the independent client could not parse the product response.',
      larger: 'The independent client decoded Mug, quantity 2, despite the larger transfer.',
      wrong: 'The independent client expected Mug, quantity 2, and received Cup, quantity 2.',
    }[option.value];
    const replayNote = source + ' replay of ' + name + '. ' + observation;
    showVerdict(parseHar(window.HarfoldGzipDemo[option.value]), source + ' · ' + name, {
      replayNote, observedBehavior: option.dataset.behavior, observation,
    });
  }

  function setCheck(contract, source, sample = false) {
    checkVersion++;
    candidateVersion++;
    currentCheck = contract;
    resetBehavior();
    $('check-active').hidden = !contract;
    $('check-intro').hidden = Boolean(contract);
    $('try-check-demo').hidden = Boolean(contract);
    $('try-json-demo').hidden = Boolean(contract);
    $('case-replay').hidden = true;
    $('demo-replay').hidden = !sample;
    $('check-notice').textContent = '';
    $('check-result').replaceChildren();
    $('check-result').removeAttribute('data-state');
    $('prompt-disclosure').open = false;
    $('check-prompt').value = '';
    if (!contract) return;
    $('check-source').textContent = source;
    $('check-target').textContent = contract.method + ' ' + contract.origin + contract.path;
    let rule = 'Require an HTTP status from 200 to 299.';
    if (contract.kind === 'bytes') rule = 'Require HTTP 200 and a positive byte count at or below ' + measuredValue('bytes', contract.maxBytes) + ' using the ' + contract.byteSource + ' measurement.';
    if (contract.kind === 'json') rule = 'Check the recorded HTTP 200 response for valid JSON syntax. A missing response body is inconclusive. Verify the expected content in a separate functional test.';
    $('check-rule').textContent = rule;
    $('check-before').textContent = measuredValue(contract.kind, contract.evidence.before);
    $('check-after').textContent = measuredValue(contract.kind, contract.evidence.after);
    $('check-prompt').value = window.HarfoldContractPrompt.prompt(contract);
  }

  async function openSavedCheck(file) {
    if (!file) return;
    setCheck(null);
    const version = checkVersion;
    $('check-notice').textContent = 'Reading ' + file.name + '…';
    try {
      const raw = await readJson(file, 'This file must contain a JSON acceptance check.');
      if (version !== checkVersion) return;
      window.HarfoldContract.validate(raw);
      setCheck(raw, 'Saved evidence · ' + file.name);
    } catch (error) {
      if (version === checkVersion) $('check-notice').textContent = 'Could not open ' + file.name + '. ' + error.message;
    }
  }

  async function verifyCandidate(file) {
    if (!file || !currentCheck) return;
    resetBehavior();
    const version = ++candidateVersion;
    const result = $('check-result');
    $('check-prompt').value = window.HarfoldContractPrompt.prompt(currentCheck);
    $('check-notice').textContent = '';
    result.removeAttribute('data-state');
    result.textContent = 'Reading ' + file.name + '…';
    try {
      const raw = await readJson(file, 'This file must contain a HAR recording in JSON format.');
      if (version !== candidateVersion) return;
      showVerdict(parseHar(raw), file.name);
    } catch (error) {
      if (version === candidateVersion) {
        result.dataset.state = 'invalid';
        result.replaceChildren(node('strong', 'verdict-label', 'Invalid capture'), node('span', 'verdict-file', file.name),
          node('p', '', error.message));
      }
    }
  }

  function showVerdict(capture, name, { replayNote = '', observedBehavior, observation } = {}) {
    resetBehavior();
    const verdict = window.HarfoldContract.check(currentCheck, capture);
    const sampleNote = replayNote ? '> ' + replayNote + '\n\n' : '';
    $('check-prompt').value = sampleNote + window.HarfoldContractPrompt.prompt(currentCheck, verdict, observedBehavior);
    $('check-notice').textContent = '';
    const result = $('check-result');
    result.dataset.state = verdict.state;
    const label = { pass: 'Pass', fail: 'Fail', inconclusive: 'Inconclusive' }[verdict.state];
    result.replaceChildren(node('strong', 'verdict-label', label),
      node('span', 'verdict-file', name), node('p', '', verdict.reason));
    if (verdict.actual !== null) {
      result.append(node('div', 'verdict-measure', 'Observed · ' + measuredValue(currentCheck.kind, verdict.actual)));
    }
    if (observedBehavior) {
      result.append(node('div', 'verdict-measure', 'Independent functional test · ' + observedBehavior),
        node('p', '', observation),
        node('p', '', window.HarfoldContractPrompt.guidance(verdict.state, observedBehavior)));
    } else if (verdict.state === 'pass') {
      const note = currentCheck.kind === 'json'
        ? 'The recorded body parses as JSON. Verify its values and the user-visible behavior separately.'
        : 'Network check passed. Test the user-visible behavior separately.';
      result.append(node('p', '', note));
    }
    if (!replayNote) {
      candidateVerdict = verdict;
      $('behavior-field').hidden = false;
    }
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
      if (change.state === 'matched') content.append(checkCreator(change));
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
  $('open-check').addEventListener('click', () => $('check-dialog').showModal());
  $('try-check-demo').addEventListener('click', showCheckDemo);
  $('try-json-demo').addEventListener('click', showJsonDemo);
  $('run-case-sample').addEventListener('click', runCaseSample);
  $('candidate-behavior').addEventListener('change', event => {
    if (!candidateVerdict) return;
    const behavior = event.target.value || undefined;
    $('behavior-assessment').textContent = behavior ? window.HarfoldContractPrompt.guidance(candidateVerdict.state, behavior) : '';
    $('check-prompt').value = window.HarfoldContractPrompt.prompt(currentCheck, candidateVerdict, behavior);
    $('check-notice').textContent = '';
  });
  for (const [key, name] of [['a', 'baseline'], ['b', 'regression']]) {
    $('replay-' + key).addEventListener('click', () => {
      if (!currentCheck || $('demo-replay').hidden) return;
      candidateVersion++;
      const replayNote = 'Demo replay of the known ' + name + ' capture. Verify a repair with a fresh, independent recording.';
      showVerdict(demoCaptures[key].data, 'Known ' + name + ' · ' + demoCaptures[key].name, { replayNote });
    });
  }
  for (const [id, handler] of [['check-file', openSavedCheck], ['candidate-file', verifyCandidate]]) {
    $(id).addEventListener('change', event => {
      const file = event.target.files[0];
      event.target.value = '';
      handler(file);
    });
  }
  $('save-check').addEventListener('click', () => {
    if (!currentCheck) return;
    download('contract.json', JSON.stringify(currentCheck, null, 2) + '\n', 'application/json;charset=utf-8');
    $('check-notice').textContent = 'Saved contract.json.';
  });
  $('copy-prompt').addEventListener('click', async () => {
    if (!currentCheck) return;
    const version = checkVersion;
    const text = $('check-prompt').value;
    try {
      await navigator.clipboard.writeText(text);
      if (version === checkVersion && text === $('check-prompt').value) $('check-notice').textContent = 'Task prompt copied.';
    } catch {
      if (version !== checkVersion || text !== $('check-prompt').value) return;
      $('prompt-disclosure').open = true;
      $('check-prompt').focus();
      $('check-prompt').select();
      $('check-notice').textContent = 'Prompt selected. Use your device’s Copy command.';
    }
  });
  $('export-report').addEventListener('click', () => {
    const diff = view === 'compare';
    const report = diff ? markdown(captures.a.data, captures.b.data, comparison) : markdown(captures[active].data);
    download(diff ? 'harfold-comparison.md' : 'harfold-capture.md', report, 'text/markdown;charset=utf-8');
    announce('Exported Markdown with hostnames and paths. Review before sharing.');
  });
  setDemo();
  if (location.hash === '#acceptance-demo') showCheckDemo();
  if (location.hash === '#json-demo') showJsonDemo();
})();
