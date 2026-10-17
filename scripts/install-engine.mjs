// Downloads the Stockfish npm package and copies its lite single-threaded
// WebAssembly build (~1.9 MB) into public/engine for the analysis board.
// Stockfish is GPL-3.0; it is served as a separate program, unmodified, and its
// licence is copied alongside it.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VERSION = '19.0.1';
const FILES = ['bin/stockfish-19-lite-single.js', 'bin/stockfish-19-lite-single.wasm', 'Copying.txt'];
const dest = 'public/engine';

const work = mkdtempSync(join(tmpdir(), 'stockfish-'));
try {
  execFileSync('npm', ['pack', `stockfish@${VERSION}`, '--pack-destination', work, '--silent'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  execFileSync('tar', ['-xzf', join(work, tarball), '-C', work, ...FILES.map((f) => `package/${f}`)]);
  mkdirSync(dest, { recursive: true });
  for (const f of FILES) copyFileSync(join(work, 'package', f), join(dest, f.split('/').pop()));
  console.log(`installed Stockfish ${VERSION} (lite, single-threaded) into ${dest}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
