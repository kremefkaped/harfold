// Build a portable HTML file with the same app and no external assets.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n?/g, '\n');
const scripts = [];
let html = read('index.html').replace(/<script src="([\w.-]+\.js)" defer><\/script>/g, (_, name) => {
  scripts.push(read(name));
  return '';
});
if (!scripts.length) throw new Error('No application scripts found in index.html.');
const hashes = scripts.map(source => "'sha256-" + createHash('sha256').update(source).digest('base64') + "'");
const icon = Buffer.from(read('favicon.svg')).toString('base64');
html = html.replace("script-src 'self'", 'script-src ' + hashes.join(' '))
  .replace('<html lang="en">', () => '<!--\n' + read('LICENSE') + '\n-->\n<html lang="en">')
  .replace('href="favicon.svg"', 'href="data:image/svg+xml;base64,' + icon + '"')
  .replace('<link rel="stylesheet" href="style.css">', () => '<style>' + read('style.css') + '</style>')
  .replace('</body>', () => scripts.map(source => '<script>' + source + '</script>').join('\n') + '\n</body>');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'harfold.html'), html);
console.log('Built dist/harfold.html');
