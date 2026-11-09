/* Shared by the browser app and Node's test runner. */
(() => {
  "use strict";

  const MAX_ENTRIES = 50000;
  const RESOURCE_TYPES = new Set([
    "document", "script", "stylesheet", "image", "font", "media", "fetch", "xhr",
  ]);

  function durationValue(value) {
    return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  }

  function byteValue(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function responseBytes(response) {
    for (const value of [response?._transferSize, response?.transferSize]) {
      if (byteValue(value)) return { bytes: value, byteSource: "transfer" };
    }
    const body = response?.bodySize;
    if (!byteValue(body)) return { bytes: null, byteSource: null };
    if (byteValue(response.headersSize)) {
      const total = response.headersSize + body;
      return byteValue(total)
        ? { bytes: total, byteSource: "headers+body" }
        : { bytes: null, byteSource: null };
    }
    return { bytes: body, byteSource: "body" };
  }

  function resourceType(entry) {
    const kind = typeof entry._resourceType === "string" && entry._resourceType.toLowerCase();
    if (RESOURCE_TYPES.has(kind)) return kind;
    const mimeType = entry.response?.content?.mimeType;
    if (typeof mimeType !== "string") return "other";
    const mime = mimeType.split(";", 1)[0].trim().toLowerCase();
    if (mime === "text/html" || mime === "application/xhtml+xml") return "document";
    if (mime === "text/css") return "stylesheet";
    if (/(java|ecma)script$/.test(mime)) return "script";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("font/") || /^application\/(x-font-|font-)/.test(mime)) return "font";
    if (/^(video|audio)\//.test(mime)) return "media";
    return "other";
  }

  function timing(entry) {
    const t = entry.timings || {};
    const connect = durationValue(t.connect) ? t.connect : 0;
    // HAR includes TLS within connect. Split it out without counting it twice.
    const ssl = durationValue(t.ssl) ? Math.min(t.ssl, connect) : 0;
    const parts = [
      ["blocked", t.blocked], ["dns", t.dns], ["connect", connect - ssl],
      ["ssl", ssl], ["send", t.send], ["wait", t.wait], ["receive", t.receive],
    ];
    let time = entry.time;
    if (!durationValue(time)) {
      // Without all mandatory phases the measured duration cannot be reconstructed.
      if (![t.send, t.wait, t.receive].every(durationValue)) return null;
      time = parts.reduce((sum, [, value]) => sum + (durationValue(value) ? value : 0), 0);
      if (!durationValue(time)) return null;
    }
    const phases = [];
    let offset = 0;
    for (const [name, value] of parts) {
      if (!durationValue(value) || value === 0 || offset >= time) continue;
      // Some exporters round each phase independently of the reported total.
      const length = Math.min(value, time - offset);
      phases.push({ name, start: offset, time: length });
      offset += length;
    }
    return { time, phases };
  }

  function normalize(entry, index) {
    const rawUrl = entry?.request?.url;
    if (typeof rawUrl !== "string" || !/^https?:\/\//i.test(rawUrl)) return null;
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    const method = entry.request.method;
    if (typeof method !== "string" || !/^[!#$%&'*+.^_`|~A-Za-z0-9-]{1,64}$/.test(method)) {
      return null;
    }
    const start = typeof entry.startedDateTime === "string" ? Date.parse(entry.startedDateTime) : NaN;
    const measured = timing(entry);
    if (!Number.isFinite(start) || !measured) return null;
    const status = entry.response?.status;
    return {
      id: "r" + (index + 1), index, method, origin: url.origin, host: url.host,
      path: url.pathname, label: url.host + url.pathname,
      status: status === 0 || (Number.isInteger(status) && status >= 100 && status <= 599)
        ? status : null,
      type: resourceType(entry), start, ...measured, ...responseBytes(entry.response),
    };
  }

  function parseHar(raw) {
    const entries = raw?.log?.entries;
    if (!Array.isArray(entries)) throw new Error("Expected a HAR file with a log.entries array.");
    if (entries.length > MAX_ENTRIES) {
      throw new Error("Capture exceeds the 50,000-entry limit. Export a shorter recording.");
    }
    const requests = [];
    for (const [index, entry] of entries.entries()) {
      const normalized = normalize(entry, index);
      if (normalized) requests.push(normalized);
    }
    requests.sort((a, b) => a.start - b.start || a.index - b.index);
    const first = requests[0]?.start ?? 0;
    let duration = 0;
    let bytes = 0;
    let errors = 0;
    for (const request of requests) {
      request.start -= first;
      duration = Math.max(duration, request.start + request.time);
      if (request.status >= 400) errors++;
      if (request.bytes === null || bytes === null || !byteValue(bytes + request.bytes)) {
        bytes = null;
      } else {
        bytes += request.bytes;
      }
    }
    return { requests, duration, bytes, errors, count: requests.length, skipped: entries.length - requests.length };
  }

  function indexRequests(requests) {
    const occurrences = new Map();
    const indexed = new Map();
    for (const request of requests) {
      const identity = request.method + " " + request.origin + request.path;
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      indexed.set(identity + " #" + occurrence, request);
    }
    return indexed;
  }

  function comparisonRow(key, before, after) {
    const { method, label } = before ?? after;
    const state = before && after ? "matched" : before ? "removed" : "added";
    const delta = before && after ? after.time - before.time : null;
    return { key, label, method, before, after, delta, state };
  }

  function compareHars(before, after) {
    const unmatched = indexRequests(after.requests);
    const rows = [];
    for (const [key, previous] of indexRequests(before.requests)) {
      rows.push(comparisonRow(key, previous, unmatched.get(key) ?? null));
      unmatched.delete(key);
    }
    for (const [key, next] of unmatched) rows.push(comparisonRow(key, null, next));
    return {
      rows, durationDelta: after.duration - before.duration,
      bytesDelta: before.bytes === null || after.bytes === null ? null : after.bytes - before.bytes,
    };
  }

  const engine = { parseHar, compareHars };
  if (typeof module !== "undefined" && module.exports) module.exports = engine;
  if (typeof window !== "undefined") window.HarfoldEngine = engine;
})();
