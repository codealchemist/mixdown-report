#!/usr/bin/env node
/**
 * Writes the calibration preset into Logic's Channel EQ presets, in a "Mixdown Report" subfolder,
 * so it can be checked in Logic (see docs/pst-format.md). Pass a folder to write somewhere else.
 *
 *   npm run calibration
 *   npm run calibration -- ./out
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CALIBRATION_EQ, encodeChannelEq } from '../src/core/eq/pst.js';
import { eqLines } from '../src/core/eq/channel-eq.js';

const folder = process.argv[2] ?? join(homedir(), 'Music', 'Audio Music Apps', 'Plug-In Settings', 'Channel EQ', 'Mixdown Report');
mkdirSync(folder, { recursive: true });
const file = join(folder, 'Mixdown Calibration.pst');
writeFileSync(file, encodeChannelEq(CALIBRATION_EQ));

console.log(`Wrote ${file}\n`);
console.log('In Logic: Channel EQ › Setting menu › Mixdown Report › Mixdown Calibration. It should show:');
for (const line of eqLines(CALIBRATION_EQ)) console.log(`  ${line}`);
