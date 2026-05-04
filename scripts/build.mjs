#!/usr/bin/env node
/**
 * Client-side TypeScript build. Compiles `src/**\/*.ts` into `build/**\/*.mjs`
 * preserving the directory structure and native ES module imports. The
 * browser loads the compiled .mjs files directly — no bundling, matching
 * the no-build-step-at-runtime philosophy.
 *
 * Usage:
 *   node scripts/build.mjs          # one-shot build
 *   node scripts/build.mjs --watch  # watch + rebuild on change
 */

import * as esbuild from 'esbuild';
import { readdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'build');

/** Recursively collect all .ts files under src/, ignoring declaration files. */
async function collectSources(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await collectSources(p, acc);
    else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

/** Mirror non-TS assets (worklets, etc.) into build/ so the browser can
 *  still fetch them at their expected paths. */
async function copyAssets() {
  const keep = ['audio/shared/audio-processor.js'];
  for (const rel of keep) {
    const from = join(SRC, rel);
    const to = join(OUT, rel);
    await copyFile(from, to).catch(() => {});
  }
}

// esbuild preserves `.ts` import specifiers as-is in output; browsers need `.mjs`.
// Post-process .mjs files to rewrite `./foo.ts` → `./foo.mjs` in imports.
async function rewriteImportExtensions(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await rewriteImportExtensions(p);
    } else if (e.isFile() && e.name.endsWith('.mjs')) {
      const content = await readFile(p, 'utf8');
      // Covers both static `from './foo.ts'` and dynamic `import('./foo.ts')`.
      const rewritten = content.replace(
        /((?:from|import)\s*\(?\s*['"](?:\.\.?\/)[^'"]+)\.ts(['"])/g,
        '$1.mjs$2',
      );
      if (rewritten !== content) await writeFile(p, rewritten);
    }
  }
}

/** Vendor bundle for @ricky0123/vad-web — Silero VAD WebAssembly speech
 *  classifier used by src/audio/shared/speechVad.ts. The library ships
 *  CommonJS in node_modules; the browser-direct UMD bundle externalizes
 *  onnxruntime-web. We produce a SINGLE ESM that includes both, dynamic-
 *  imported on demand from the SpeechVAD adapter so the cold-start cost
 *  is paid only when a barge loop spins up (not on every page load).
 *
 *  Output: build/vendor/vad-web.mjs (≈ a few hundred KB of JS — the wasm
 *  + onnx model + audio worklet are loaded separately at runtime from
 *  /assets/vad/, NOT bundled in here). */
async function buildVendorBundles() {
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/audio/shared/speechVad/vendor-entry.mjs')],
    outfile: join(OUT, 'vendor/vad-web.mjs'),
    format: 'esm',
    target: 'es2022',
    bundle: true,
    minify: true,
    sourcemap: false,
    logLevel: 'info',
    // Keep the wasm/onnx/worklet asset references resolved at runtime via
    // the adapter's `baseAssetPath` / `onnxWASMBasePath` options — esbuild
    // shouldn't try to inline them into the JS bundle.
    loader: { '.wasm': 'file', '.onnx': 'file' },
  });
}

async function build({ watch }) {
  await rm(OUT, { recursive: true, force: true });
  const entries = await collectSources(SRC);
  const opts = {
    entryPoints: entries,
    outdir: OUT,
    outbase: SRC,
    format: 'esm',
    target: 'es2022',
    bundle: false,                   // native imports, not a bundle
    sourcemap: 'linked',
    outExtension: { '.js': '.mjs' }, // keep .mjs URLs stable in HTML/SW
    logLevel: 'info',
  };
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log(`[build] watching ${entries.length} files under src/`);
  } else {
    await esbuild.build(opts);
    await copyAssets();
    await rewriteImportExtensions(OUT);
    await buildVendorBundles();
    console.log(`[build] compiled ${entries.length} files → ${relative(ROOT, OUT)}/`);
  }
}

const watch = process.argv.includes('--watch');
build({ watch }).catch(err => {
  console.error('[build] failed:', err);
  process.exit(1);
});
