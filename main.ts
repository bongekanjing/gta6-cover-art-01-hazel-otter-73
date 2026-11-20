// main.ts — the hand-in program for this entry.
//
// The app is the app/ directory beside this file: plain HTML, CSS and ES modules that a
// desktop browser opens offline, with no dependency and no network request. This program
// does not draw anything; it packages what the app already is and summarises it.
//
// The judge reads output/dossier.json. It is written by make.fun's own library (vendored
// beside this file at vendor/makefun-app.ts, byte for byte the scorer's copy), so the
// summary is computed from the handed-in tree by the same code the scorer runs.
//
// Locally, MAKEFUN_OUTPUT_DIR stands in for the container's /output:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-app.ts';

/** Where this program lives, with a trailing slash. */
const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's limits (reference/gate.json), mirrored so a doomed entry fails here, not there. */
const CAPS = {
  // The dossier's own text size budget.
  text_max_bytes: 163_840,
  // At most four screenshots, none over 256 KiB.
  screenshots: { max: 4, max_bytes: 262_144 },
  // app/ holds at most 993 entries, 48 MiB in all, and no path longer than 1000 bytes.
  app_max_files: 993,
  app_max_bytes: 50_331_648,
  app_path_max_bytes: 1_000,
} as const;

/**
 * Copy one directory of this repository into the hand-in tree.
 *
 * `required` is true for app/, which must exist: without it there is no entry at all.
 * screenshots/ is optional here, though the gate wants three or four of them.
 */
function handIn(name: string, required: boolean): void {
  const from = join(here, name);
  if (!existsSync(from)) {
    if (required) throw new Error(`main.ts: ${name}/ is missing from ${here}`);
    return;
  }
  if (!statSync(from).isDirectory()) throw new Error(`main.ts: ${name} is not a directory`);
  cpSync(from, join(out, name), { recursive: true });
}

const out = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
mkdirSync(out, { recursive: true });

handIn('app', true);
handIn('screenshots', false);

writeFileSync(join(out, 'dossier.json'), buildDossier(out, CAPS));

process.stdout.write(`wrote ${join(out, 'dossier.json')}\n`);
