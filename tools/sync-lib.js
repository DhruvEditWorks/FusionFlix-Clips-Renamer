#!/usr/bin/env node
/**
 * Copies the shared pure-logic libraries into renderer/lib/ so the renderer can
 * load them as plain scripts (the preload runs sandboxed and cannot require()
 * local files). Run with: npm run sync  (also runs on postinstall and prebuild)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['sanitize.js', 'filenames.js', 'validate.js', 'shortcuts.js'];
const targetDir = path.join(ROOT, 'renderer', 'lib');

fs.mkdirSync(targetDir, { recursive: true });

let copied = 0;
for (const file of FILES) {
  const src = path.join(ROOT, 'lib', file);
  const dest = path.join(targetDir, file);
  const content = fs.readFileSync(src);
  const existing = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  if (!existing || !existing.equals(content)) {
    fs.writeFileSync(dest, content);
    copied += 1;
  }
}

const banner = `THIS FOLDER IS GENERATED — do not edit these files.\nSource of truth: /lib/*.js  →  rebuild with: npm run sync\n`;
fs.writeFileSync(path.join(targetDir, 'README.txt'), banner);

process.stdout.write(`sync-lib: ${copied} file(s) updated in renderer/lib/ (${FILES.length} tracked)\n`);
