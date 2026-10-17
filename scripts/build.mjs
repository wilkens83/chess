// Bundles the browser code into public/build with content-hashed file names
// and writes public/build/manifest.json mapping logical names to hashed files.
// Usage: node scripts/build.mjs [--watch]

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import * as esbuild from 'esbuild';

const outdir = 'public/build';
const watch = process.argv.includes('--watch');

/** @type {esbuild.Plugin} */
const manifestPlugin = {
  name: 'manifest',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length || !result.metafile) return;
      const manifest = {};
      for (const [file, out] of Object.entries(result.metafile.outputs)) {
        if (!out.entryPoint) continue;
        const name = basename(out.entryPoint).replace(/\.ts$/, '.js');
        manifest[name] = relative(outdir, file);
      }
      writeFileSync(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2));
      console.log(`built ${Object.keys(manifest).length} entries`);
    });
  },
};

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const options = {
  entryPoints: ['src/client/pages/lobby.ts', 'src/client/pages/round.ts', 'src/client/pages/analysis.ts', 'src/client/style.css'],
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  minify: !watch,
  sourcemap: true,
  entryNames: '[name].[hash]',
  chunkNames: 'lib.[hash]',
  metafile: true,
  logLevel: 'warning',
  plugins: [manifestPlugin],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching for changes…');
} else {
  await esbuild.build(options);
}
