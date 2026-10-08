#!/usr/bin/env node
/**
 * Prints Channel EQ presets as decoded bands and raw parameters side by side,
 * for checking exports and mapping unknown parameters (see docs/pst-format.md).
 *
 *   npm run pst -- "Lead vocal.pst"
 *   npm run pst -- stereo.pst side.pst      # differing parameters are marked with *
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeChannelEq } from '../src/core/eq/pst.js';
import { eqLines } from '../src/core/eq/channel-eq.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: npm run pst -- <preset.pst> [more.pst …]');
  process.exit(1);
}

const decoded = files.map((file) => {
  const bytes = readFileSync(file);
  const { eq, paramCount } = decodeChannelEq(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw = Array.from({ length: paramCount }, (_, i) => view.getFloat32(28 + i * 4, true));
  return { name: basename(file), size: bytes.length, eq, raw };
});

for (const d of decoded) {
  console.log(`\n${d.name} (${d.size} bytes, ${d.raw.length} parameters)`);
  for (const line of eqLines(d.eq)) console.log(`  ${line}`);
}

const fmt = (v) => (v === undefined ? '' : Number.isInteger(v) ? String(v) : v.toPrecision(5).replace(/\.?0+$/, ''));
const rows = Math.max(...decoded.map((d) => d.raw.length));
console.log(`\n${'param'.padEnd(7)}${decoded.map((d) => d.name.slice(0, 18).padStart(20)).join('')}`);
for (let i = 0; i < rows; i++) {
  const values = decoded.map((d) => d.raw[i]);
  const differs = decoded.length > 1 && new Set(values.map(fmt)).size > 1;
  console.log(`${`p${i}`.padEnd(5)}${differs ? '* ' : '  '}${values.map((v) => fmt(v).padStart(20)).join('')}`);
}
