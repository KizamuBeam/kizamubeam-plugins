#!/usr/bin/env node
// Builds catalog.json (compatible with KizamuBeam src/catalog.ts) from plugins/*/dist/*.kzp
// and signs it with Ed25519 when PACKS_SIGNING_KEY (64-char hex seed) is set.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname: on Windows .pathname gives /E:/… and no plugin folder is found
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = resolve(process.argv[2] ?? join(root, '_site'));
const pluginsDir = join(root, 'plugins');
const CATALOG_FORMAT = 'kizamubeam-catalog';
const REPO = 'https://github.com/KizamuBeam/kizamubeam-plugins/tree/main';

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function signEd25519(data, seedHex) {
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seedHex.toLowerCase(), 'hex'),
  ]);
  const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return sign(null, data, priv);
}

const entries = [];
mkdirSync(outDir, { recursive: true });

/**
 * Icon and preview of the first plugin that has one (iconImage, previewImage as data: URLs): written next to
 * catalog.json as <id>.icon.png and <id>.preview.png|jpg and named in the entry with SHA-256 and size, the same way
 * KizamuBeam's scripts/build-catalog.ts does it. The app checks checksum, format and size before showing them.
 */
function catalogImages(raw) {
  const out = {};
  const plugs = Array.isArray(raw.plugins) ? raw.plugins : [];
  for (const [kind, key] of [['icon', 'iconImage'], ['preview', 'previewImage']]) {
    const url = plugs.map((x) => x?.[key]).find((x) => typeof x === 'string');
    if (!url) continue;
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!m || (kind === 'icon' && m[1] !== 'png')) throw new Error(`${raw.id}: ${key} must be a ${kind === 'icon' ? 'PNG' : 'PNG or JPEG'} data: URL`);
    const bytes = Buffer.from(m[2], 'base64');
    const file = `${raw.id}.${kind}.${m[1] === 'png' ? 'png' : 'jpg'}`;
    writeFileSync(join(outDir, file), bytes);
    out[kind] = { file, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  }
  return out;
}

if (existsSync(pluginsDir)) {
  for (const dirName of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, dirName);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'plugin.json'))) continue;
    const distDir = join(dir, 'dist');
    if (!existsSync(distDir)) continue;

    for (const file of readdirSync(distDir).filter((f) => f.endsWith('.kzp')).sort()) {
      const srcPath = join(distDir, file);
      const text = readFileSync(srcPath, 'utf8');
      const raw = JSON.parse(text);
      if (raw.format !== 'kizamubeam-pack') {
        throw new Error(`${file}: invalid format "${raw.format}"`);
      }
      if (file !== `${raw.id}.kzp`) {
        throw new Error(`${file}: filename must match id (${raw.id}.kzp)`);
      }
      const plugs = Array.isArray(raw.plugins) ? raw.plugins : [];
      const runtimes = [...new Set(plugs.map((x) => x.runtime).filter(Boolean))].sort();
      const pluginApi = plugs.length ? Math.max(...plugs.map((x) => Number(x.api || 1))) : 0;
      const codeSize = plugs.reduce(
        (sum, x) => sum + (typeof x.code === 'string' ? Buffer.from(x.code, 'base64').length : 0),
        0,
      );
      const network = [
        ...new Set(
          plugs.flatMap((x) => (Array.isArray(x.network) ? x.network.map((h) => h?.hostname ?? h).filter(Boolean) : [])),
        ),
      ].sort();

      entries.push({
        id: raw.id,
        version: raw.version,
        ...(raw.minApp ? { minApp: raw.minApp } : {}),
        name: raw.name,
        ...(raw.description ? { description: raw.description } : {}),
        ...(raw.author ? { author: raw.author } : {}),
        ...(raw.homepage ? { homepage: raw.homepage } : {}),
        devices: Array.isArray(raw.devices) ? raw.devices.length : 0,
        templates: Array.isArray(raw.templates) ? raw.templates.length : 0,
        materials: Array.isArray(raw.materials) ? raw.materials.length : 0,
        assets: Array.isArray(raw.assets) ? raw.assets.length : 0,
        plugins: plugs.length,
        ...(plugs.length ? { runtimes, pluginApi, codeSize } : {}),
        ...(network.length ? { network } : {}),
        ...catalogImages(raw),
        source: `${REPO}/plugins/${dirName}`,
        file,
        sha256: sha256Hex(text),
        size: Buffer.byteLength(text, 'utf8'),
      });

      copyFileSync(srcPath, join(outDir, file));
    }
  }
}

entries.sort((a, b) => a.id.localeCompare(b.id));

const catalogJson =
  JSON.stringify(
    {
      format: CATALOG_FORMAT,
      version: 1,
      generated: new Date().toISOString(),
      packs: entries,
    },
    null,
    1,
  ) + '\n';

const catalogPath = join(outDir, 'catalog.json');
writeFileSync(catalogPath, catalogJson, 'utf8');
console.log(`Built catalog.json with ${entries.length} plugin pack(s) in ${outDir}`);

const key = (process.env.PACKS_SIGNING_KEY ?? '').trim();
if (/^[0-9a-f]{64}$/i.test(key)) {
  const sig = signEd25519(Buffer.from(catalogJson, 'utf8'), key);
  writeFileSync(`${catalogPath}.sig`, sig.toString('base64') + '\n', 'utf8');
  console.log(`Signed ${catalogPath}.sig`);
} else {
  console.log('::warning::PACKS_SIGNING_KEY not set or invalid – catalog.json left unsigned.');
}
