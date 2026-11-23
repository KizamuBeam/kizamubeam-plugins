# KizamuBeam Plugins

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/kizamubeam-logo-dark.png">
    <img src="docs/brand/kizamubeam-logo.png" alt="KizamuBeam" width="520">
  </picture>
</p>

<p align="center">
  <b>Plugins (generators, path tools, and extensions) for KizamuBeam.</b>
</p>

<p align="center">
  <a href="https://github.com/KizamuBeam/kizamubeam">KizamuBeam</a> ·
  <a href="https://github.com/KizamuBeam/kizamubeam-packs">Packs (Motifs & Patterns)</a> ·
  <a href="https://github.com/KizamuBeam/kizamubeam-devices">Device Profiles</a> ·
  <a href="https://kizamubeam.github.io/kizamubeam/docs/">Manual</a> ·
  <a href="https://discord.gg/SSr8VHh7EJ">Discord</a> ·
  <a href="README.de.md">Deutsch</a>
</p>

This repository hosts plugins for [KizamuBeam](https://github.com/KizamuBeam/kizamubeam), including parametric generators, path tools, and starter SDKs/templates for TypeScript (QuickJS) and Rust (WebAssembly).

## Repository Structure

| Folder | Purpose |
| --- | --- |
| `plugins/` | Individual plugins (`plugins/<name>/plugin.json` + source) |
| `sdk/` | Plugin SDKs for TypeScript (`sdk/ts/`) and Rust (`sdk/rust/`) |
| `templates/` | Starter templates for TypeScript and Rust plugins |
| `scripts/` | Build and validation scripts (`plugin-pack.mjs`, `validate.mjs`) |

## Creating a Plugin

1. Copy a starter template into `plugins/`:
   - **TypeScript:** `cp -r templates/typescript plugins/my-plugin`
   - **Rust (WASM):** `cp -r templates/rust plugins/my-plugin`
2. Update `plugins/my-plugin/plugin.json` with a unique `id`, `name`, `version`, and `author`.
3. Build a `.kzp` extension pack from your plugin:
   ```bash
   npm install
   npm run pack -- plugins/my-plugin
   ```
   The generated `.kzp` file is written to `plugins/my-plugin/dist/<id>.kzp` and can be installed directly in KizamuBeam via **File → Extension Packs …**.
4. Validate all plugins:
   ```bash
   npm test
   ```

Optionally, a plugin can bring its own pictures: `"iconImage": "@icon.png"` (square PNG, 32–512 px, at most 128 KB) for its tile in the Toolbox and `"previewImage": "@preview.png"` (PNG or JPEG, 120–2048 px per side, at most 512 KB) for the Extensions window. `npm run pack` puts the files into the pack, and the catalogue publishes them next to `catalog.json`. Keep `icon` as a fallback for older app versions. Details: [Icon and preview picture](https://github.com/KizamuBeam/kizamubeam/blob/main/docs/plugins.md#icon-and-preview-picture).

For the full plugin API reference, see [docs/plugins.md](https://github.com/KizamuBeam/kizamubeam/blob/main/docs/plugins.md) in the main repository.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
