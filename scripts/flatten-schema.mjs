// Flattens schema.sql to a single line for the D1 console (which only accepts one line).
// Newlines inside string literals are written as char(10). Comments are dropped.
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const out = [];
let inStr = false, buf = '';
for (let i = 0; i < src.length; i++) {
  const ch = src[i];
  if (!inStr && ch === '-' && src[i + 1] === '-') {           // line comment
    while (i < src.length && src[i] !== '\n') i++;
    buf += ' ';
    continue;
  }
  if (ch === "'") { inStr = !inStr; buf += ch; continue; }
  if (ch === '\n') { buf += inStr ? "'||char(10)||'" : ' '; continue; }
  buf += ch;
}
out.push(buf.replace(/\s+/g, ' ').replace(/\s*;\s*/g, '; ').trim());
writeFileSync(new URL('../schema.oneline.sql', import.meta.url), out.join('') + '\n');
console.log('schema.oneline.sql written');
