/* Reduced from local browser recordings of Starlette #1901.
 * The four responses keep the recorded text, decoded size and transfer count.
 * The endpoint and timestamp are fixed demo identifiers. No headers are included.
 */
(() => {
  'use strict';
  function capture(text, decodedBytes, transferBytes) {
    return { log: { entries: [{
      startedDateTime: '2026-01-01T00:00:00Z', time: 1,
      request: { method: 'GET', url: 'https://shop.example/data.json' },
      response: { status: 200, _transferSize: transferBytes,
        content: { mimeType: 'application/json', size: decodedBytes, text } },
    }] } };
  }

  const samples = {
    good: capture("{\"product\": \"Mug\", \"quantity\": 2}", 33, 201),
    bad: capture("\u001f\ufffd\b\u0000\u0000\u0000\u0000\u0000\u0002\ufffd\ufffdV*(\ufffdO)M.Q\ufffdRP\ufffd-MW\ufffdQP*,M\ufffd+\ufffd,\ufffd\u0004\n\u0019\ufffd\u0002\u0000\ufffd\u05f8\ufffd!\u0000\u0000\u0000", 52, 242),
    larger: capture("{\"product\": \"Mug\", \"quantity\": 2}", 33, 363),
    wrong: capture("{\"product\": \"Cup\", \"quantity\": 2}", 33, 201),
  };
  if (typeof window !== 'undefined') window.HarfoldGzipDemo = samples;
  if (typeof module !== 'undefined' && module.exports) module.exports = samples;
})();
