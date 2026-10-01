#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * FUSION FLIX - CLIP RENAMER & SORTER
 * tools/make-uninstaller-stub.js
 *
 * Compiles packaging/uninstaller-stub.nsi -> packaging/uninstaller-stub.exe
 * with the very same NSIS that electron-builder uses (it lives in the
 * electron-builder cache after the first Windows build).
 *
 *   npm run uninstaller-stub
 *
 * Why a stub is needed at all is explained at the top of
 * packaging/uninstaller-stub.nsi: the stock electron-builder template embeds a
 * file as the uninstaller before it is overwritten by WriteUninstaller at
 * install time, and pre-building the real uninstaller would require running a
 * Windows binary (wine) on the build machine.
 *
 * The stub is committed to the repository, so this script only has to run
 * after the stub's source changes.  It never fails a build: if no makensis can
 * be found it says so and leaves the existing stub in place.
 * ------------------------------------------------------------------------- */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'packaging', 'uninstaller-stub.nsi');
const OUT = path.join(ROOT, 'packaging', 'uninstaller-stub.exe');

function candidates() {
  const list = [];
  const exe = process.platform === 'win32' ? 'makensis.exe' : 'makensis';

  if (process.env.NSIS_DIR) {
    list.push(path.join(process.env.NSIS_DIR, exe));
    list.push(path.join(process.env.NSIS_DIR, 'Bin', exe));
    list.push(path.join(process.env.NSIS_DIR, 'linux', exe));
    list.push(path.join(process.env.NSIS_DIR, 'mac', exe));
  }

  const cache = path.join(os.homedir(), '.cache', 'electron-builder', 'nsis');
  try {
    for (const entry of fs.readdirSync(cache)) {
      const base = path.join(cache, entry);
      list.push(path.join(base, exe));
      list.push(path.join(base, 'linux', exe));
      list.push(path.join(base, 'mac', exe));
      list.push(path.join(base, 'Bin', exe));
    }
  } catch {
    /* no cache yet - a Windows build will create it */
  }

  if (process.platform === 'win32') {
    for (const dir of ['C:\\Program Files (x86)\\NSIS', 'C:\\Program Files\\NSIS']) {
      list.push(path.join(dir, 'makensis.exe'));
    }
  }

  return list;
}

function findMakensis() {
  for (const candidate of candidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['makensis'], {
    encoding: 'utf8',
  });
  if (which.status === 0) {
    const first = String(which.stdout || '').split(/\r?\n/).filter(Boolean)[0];
    if (first) return first.trim();
  }
  return null;
}

function main() {
  if (!fs.existsSync(SCRIPT)) {
    console.log(`uninstaller-stub: ${path.relative(ROOT, SCRIPT)} is missing, nothing to do.`);
    return 0;
  }

  const makensis = findMakensis();
  if (!makensis) {
    console.log(
      'uninstaller-stub: no makensis found (it is downloaded with the first Windows build).\n' +
        `                keeping the existing ${path.relative(ROOT, OUT)}.`
    );
    return 0;
  }

  const nsisDir = findNsisDir(makensis);
  const args = ['-INPUTCHARSET', 'UTF8', '-V2', SCRIPT];
  const result = spawnSync(makensis, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: nsisDir ? { ...process.env, NSISDIR: nsisDir } : process.env,
  });

  if (result.status !== 0) {
    console.error(`uninstaller-stub: makensis failed (exit ${result.status}).`);
    return 1;
  }
  if (!fs.existsSync(OUT)) {
    console.error('uninstaller-stub: makensis reported success but produced no file.');
    return 1;
  }
  const size = fs.statSync(OUT).size;
  console.log(
    `uninstaller-stub: built ${path.relative(ROOT, OUT)} (${(size / 1024).toFixed(1)} KB)`
  );
  return 0;
}

/* makensis needs NSISDIR pointing at the folder that holds Include/ and Stubs/. */
function findNsisDir(makensis) {
  const dir = path.dirname(makensis);
  for (const probe of [dir, path.join(dir, '..'), path.join(dir, '..', 'nsis')]) {
    try {
      if (fs.existsSync(path.join(probe, 'Include', 'MUI2.nsh'))) return path.resolve(probe);
    } catch {
      /* ignore */
    }
  }
  return process.env.NSISDIR || null;
}

process.exit(main());
