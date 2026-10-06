#!/usr/bin/env node
/** Syntax-checks every JavaScript file and confirms each relative import resolves to a real file. */
import { readdir, readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'scripts', 'test'];
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]/g;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.js')) yield path;
  }
}

let failures = 0;
let count = 0;
for (const dir of DIRS) {
  for await (const file of walk(join(ROOT, dir))) {
    count++;
    const name = relative(ROOT, file);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      failures++;
      console.error(`✗ ${name}\n${error.stderr}`);
      continue;
    }
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? match[3];
      try {
        await access(resolve(dirname(file), spec));
      } catch {
        failures++;
        console.error(`✗ ${name}: missing import ${spec}`);
      }
    }
  }
}

if (failures) {
  console.error(`\n${failures} problem(s) in ${count} files`);
  process.exit(1);
}
console.log(`✓ ${count} files OK`);
