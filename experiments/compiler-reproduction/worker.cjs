'use strict';
const path = require('node:path');
const readline = require('node:readline');
const {createHash} = require('node:crypto');

// A separate cached API instance per package keeps its own WASM compiler alive.
async function main() {
  const services = new Map();
  try {
    for (const v of process.argv.slice(3)) {
      const api = require(path.join(process.argv[2], v, 'package/lib/main.js'));
      if (api.version !== v) throw Error('Package version mismatch');
      services.set(v, api);
    }
    const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
    for await (const line of lines) {
      const {version, source, sourcefile} = JSON.parse(line);
      let result;
      // The compiler runs in a child process. A stalled transform is a tool failure.
      const timeout = setTimeout(() => {
        console.error('Insufficient evidence: compiler response exceeded 20 seconds');
        process.exit(2);
      }, 20_000);
      try {
        const {code} = await services.get(version).transform(source, {
          loader: 'ts', sourcefile, format: 'esm',
        });
        result = {ok: true, emitted_sha256: createHash('sha256').update(code).digest('hex')};
      } catch (e) {
        if (!Array.isArray(e.errors) || !e.errors.length) throw e;
        result = {ok: false, errors: e.errors.map(({text,location}) => {
          if (!location) return {text};
          const {file,line,column,lineText} = location;
          return {text,file,line,column,lineText};
        })};
      } finally { clearTimeout(timeout); }
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } finally {
    await Promise.all([...services.values()].map(s => s.stop()));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
