/* A portable, single-endpoint check shared by the app and CLI. */
(() => {
  "use strict";

  const fields = ["version", "kind", "method", "origin", "path", "evidence"];
  const sources = new Set(["transfer", "headers+body", "body"]);
  const kinds = new Set(["status", "bytes", "json"]);
  const positiveBytes = n => Number.isSafeInteger(n) && n > 0;
  const successStatus = n => Number.isInteger(n) && n >= 200 && n <= 299;

  function requireFields(value, names, label) {
    if (!value || typeof value !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new Error(label + " must be a plain JSON object.");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || !keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return names.includes(key) && descriptor.enumerable && Object.hasOwn(descriptor, "value");
    })) {
      throw new Error(label + " must contain exactly these fields: " + names.join(", ") + ".");
    }
  }

  function validate(contract) {
    const kind = contract && Object.getOwnPropertyDescriptor(contract, "kind")?.value;
    requireFields(contract, kind === "bytes" ? [...fields, "maxBytes", "byteSource"] : fields, "Contract");
    if (contract.version !== 1) throw new Error("Use a version 1 Harfold contract.");
    if (!kinds.has(kind)) throw new Error("Choose a status, bytes or JSON contract.");
    const { method, origin, path, evidence } = contract;
    if (typeof method !== "string" || !/^[!#$%&'*+.^_`|~A-Za-z0-9-]{1,64}$/.test(method)) {
      throw new Error("Use a valid HTTP method.");
    }
    let url;
    if (typeof origin === "string" && typeof path === "string" && path.startsWith("/")) {
      try { url = new URL(origin + path); } catch { /* Report a safe error below. */ }
    }
    if (!url || !["https:", "http:"].includes(url.protocol) ||
        url.origin !== origin || url.pathname !== path || url.href !== origin + path) {
      throw new Error("Use a canonical HTTP(S) origin and pathname. Remove credentials, queries and fragments.");
    }
    requireFields(evidence, ["before", "after"], "Evidence");
    if (kind === "bytes") {
      if (!sources.has(contract.byteSource)) throw new Error("Use a byte source of transfer, headers+body or body.");
      if (!positiveBytes(evidence.before) || !positiveBytes(evidence.after) ||
          evidence.after <= evidence.before || contract.maxBytes !== evidence.before) {
        throw new Error("Set maxBytes to the positive baseline byte count and supply a larger comparison count.");
      }
    } else if (kind === "json") {
      if (evidence.before !== "valid" || evidence.after !== "invalid") {
        throw new Error("A JSON contract requires valid baseline JSON and invalid comparison JSON.");
      }
    } else if (!successStatus(evidence.before) || !Number.isInteger(evidence.after) ||
               evidence.after < 400 || evidence.after > 599) {
      throw new Error("A status contract requires baseline HTTP 2xx and comparison HTTP 4xx or 5xx.");
    }
    return contract;
  }

  function sameEndpoint(a, b) {
    return a.method === b.method && a.origin === b.origin && a.path === b.path;
  }

  const inconclusive = reason => ({ state: "inconclusive", reason, actual: null });

  function check(contract, capture) {
    validate(contract);
    if (!Array.isArray(capture?.requests) || capture.skipped !== 0) {
      return inconclusive("Capture is incomplete. Export a recording with no skipped entries.");
    }
    let match;
    for (const request of capture.requests) {
      if (!sameEndpoint(request, contract)) continue;
      if (match) return inconclusive("Endpoint appears more than once. Record exactly one matching request.");
      match = request;
    }
    if (!match) return inconclusive("Endpoint is missing. Record the action that sends this request.");
    if (contract.kind === "json") {
      if (match.status !== 200 || !["valid", "invalid"].includes(match.jsonState)) {
        return inconclusive("Expected an HTTP 200 response with an embedded, complete JSON body up to 1 MiB.");
      }
      return match.jsonState === "valid"
        ? { state: "pass", reason: "The recorded body parses as JSON.", actual: "valid" }
        : { state: "fail", reason: "The recorded body does not parse as JSON.", actual: "invalid" };
    }
    if (contract.kind === "status") {
      const actual = match.status;
      if (!Number.isInteger(actual) || actual < 100 || actual > 599) {
        return inconclusive("HTTP status is unavailable. Record a completed response.");
      }
      return successStatus(actual)
        ? { state: "pass", reason: "HTTP status is in the required 2xx range.", actual }
        : { state: "fail", reason: "Expected HTTP 2xx. The response returned HTTP " + actual + ".", actual };
    }
    if (match.status !== 200) return inconclusive("Byte checks require an HTTP 200 response. Record the full resource.");
    if (!positiveBytes(match.bytes)) return inconclusive("No positive byte count. Record a fresh, uncached response.");
    if (match.byteSource !== contract.byteSource) {
      return inconclusive("Byte sources differ. Export using the same response-size measurement.");
    }
    const actual = match.bytes;
    return actual <= contract.maxBytes
      ? { state: "pass", reason: "Response fits the baseline byte budget.", actual }
      : { state: "fail", reason: "Response exceeds the baseline byte budget.", actual };
  }

  function derive(before, after, row, kind) {
    if (!kinds.has(kind)) throw new Error("Choose a status, bytes or JSON contract.");
    if (row?.state !== "matched" || !row.before || !row.after || !sameEndpoint(row.before, row.after)) {
      throw new Error("Select a request with the same method, origin and path in both captures.");
    }
    const a = row.before;
    const b = row.after;
    const measurement = kind === "json" ? "jsonState" : kind;
    const contract = {
      version: 1, kind, method: a.method, origin: a.origin, path: a.path,
      evidence: { before: a[measurement], after: b[measurement] },
    };
    if (kind === "bytes") {
      if (a.byteSource !== b.byteSource) throw new Error("Both captures must report the same byte source.");
      contract.maxBytes = a.bytes;
      contract.byteSource = a.byteSource;
    }
    const baseline = check(contract, before);
    const comparison = check(contract, after);
    if (baseline.state !== "pass") throw new Error("Baseline did not pass: " + baseline.reason);
    if (comparison.state !== "fail") throw new Error("Comparison did not fail: " + comparison.reason);
    if (baseline.actual !== contract.evidence.before || comparison.actual !== contract.evidence.after) {
      throw new Error("Selected evidence differs from the captures. Select the comparison row again.");
    }
    return contract;
  }

  const api = { derive, check, validate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.HarfoldContract = api;
})();
