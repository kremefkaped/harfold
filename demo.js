// Two synthetic captures of the same storefront, before and after a release.
(() => {
  "use strict";

  const mime = {
    document: "text/html", stylesheet: "text/css", script: "text/javascript",
    image: "image/webp", font: "font/woff2", fetch: "application/json"
  };

  function storefront(after) {
    const epoch = Date.parse(after ? "2026-04-10T12:00:00Z" : "2026-04-09T12:00:00Z");
    const iso = offset => new Date(epoch + offset).toISOString();
    const entries = [];

    function resource(path, type, offset, wait, receive, bytes, status = 200) {
      const url = new URL(path, "https://storefront.example");
      const first = entries.length === 0;
      const dns = first ? 12 : -1;
      const connect = first ? 31 : -1;
      const timings = { blocked: 2, dns, connect, ssl: first ? 19 : -1, send: 1, wait, receive };
      const time = 3 + Math.max(0, dns) + Math.max(0, connect) + wait + receive;
      const bodySize = bytes - 180;
      entries.push({
        pageref: "collection",
        startedDateTime: iso(offset), time, _resourceType: type,
        request: {
          method: "GET", url: url.href, httpVersion: "h2", headers: [], cookies: [],
          queryString: Array.from(url.searchParams, ([name, value]) => ({ name, value })),
          headersSize: -1, bodySize: 0
        },
        response: {
          status, statusText: status === 200 ? "OK" : "Service Unavailable",
          httpVersion: "h2", headers: [], cookies: [], redirectURL: "",
          content: { size: bodySize, mimeType: mime[type] },
          headersSize: 180, bodySize, _transferSize: bytes
        },
        cache: {}, timings
      });
    }

    // Arguments after the type are start offset, server wait, receive (ms), and transferred bytes.
    resource("/collections/studio", "document", 0, 48, 39, 18400);
    resource("/assets/storefront.css", "stylesheet", 103, 21, 56, 23600);
    resource("/assets/storefront.js", "script", 107, after ? 37 : 29, after ? 164 : 106, after ? 168000 : 112000);
    resource("/images/hero.webp", "image", 121, 37, after ? 1390 : 370, after ? 1284000 : 142000);
    resource("/fonts/display.woff2", "font", 188, 33, 127, 38000);
    resource("/images/linen.webp", "image", 201, 25, 143, 62000);
    resource("/images/stoneware.webp", "image", 211, 27, 167, 76000);
    resource("/images/canvas-tote.webp", "image", 218, 28, 146, 64000);
    resource("/api/catalog", "fetch", 300, after ? 154 : 119, 27, 12200);
    if (after) resource("/assets/recommendations.js", "script", 351, 19, 90, 48400);
    resource("/api/stock?item=linen", "fetch", 417, 62, 6, 940);
    resource("/api/stock?item=tote", "fetch", 426, 48, 8, 1060);
    resource("/api/basket", "fetch", 472, 39, 8, 2120);
    if (!after) resource("/assets/size-guide.js", "script", 490, 27, 69, 18900);
    resource("/assets/checkout.js", "script", 542, 37, 158, 88200);
    if (after) resource("/api/recommendations", "fetch", 568, 311, 3, 540, 503);
    resource("/images/monogram.webp", "image", 700, 26, 28, 4800);

    return {
      log: {
        version: "1.2",
        creator: { name: "Harfold synthetic example", version: "1.0" },
        pages: [{ startedDateTime: iso(0), id: "collection", title: "Studio collection", pageTimings: {} }],
        entries
      }
    };
  }

  const captures = { before: storefront(false), after: storefront(true) };
  if (typeof window !== "undefined") window.HarfoldDemo = captures;
  if (typeof module === "undefined" || !module.exports) return;
  module.exports = captures;
  if (require.main !== module) return;

  const fs = require("node:fs");
  const path = require("node:path");
  const assert = require("node:assert/strict");
  const mode = process.argv[2];
  if (!["--write", "--check"].includes(mode)) throw new Error("Use node demo.js --write or --check.");
  const directory = path.join(__dirname, "examples");
  if (mode === "--write") fs.mkdirSync(directory, { recursive: true });
  for (const [slot, capture] of Object.entries(captures)) {
    const file = path.join(directory, `storefront-${slot}.har`);
    if (mode === "--write") fs.writeFileSync(file, JSON.stringify(capture, null, 2) + "\n");
    else assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), capture, file);
  }
})();
