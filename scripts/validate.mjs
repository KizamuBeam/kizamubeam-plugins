#!/usr/bin/env node
// Validates all plugin folders under plugins/ (and checks templates/typescript) by building them with plugin-pack.mjs.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// fileURLToPath, not .pathname: on Windows .pathname gives /E:/… and no plugin folder is found
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packScript = join(root, 'scripts', 'plugin-pack.mjs');

function checkDir(dir, cleanupDist = false) {
  console.log(`Checking plugin: ${dir}`);
  execFileSync(process.execPath, [packScript, '--build', dir], { stdio: 'inherit' });
  if (cleanupDist) rmSync(join(dir, 'dist'), { recursive: true, force: true });
}

// Verify the TypeScript starter template compiles cleanly
const tsTemplate = join(root, 'templates', 'typescript');
if (existsSync(join(tsTemplate, 'plugin.json'))) {
  checkDir(tsTemplate, true);
}

// Build and validate every plugin in plugins/
const pluginsDir = join(root, 'plugins');
let count = 0;
if (existsSync(pluginsDir)) {
  for (const name of readdirSync(pluginsDir).sort()) {
    const p = join(pluginsDir, name);
    if (!statSync(p).isDirectory()) continue;
    if (!existsSync(join(p, 'plugin.json'))) {
      throw new Error(`plugins/${name} is missing plugin.json`);
    }
    checkDir(p, false);
    count++;
  }
}

console.log(`Validated ${count} plugin(s) + starter template.`);
