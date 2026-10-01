# Build verification report

Generated while developing this project. Windows artifacts were produced and
verified from this exact source tree (Linux host, Electron 33, electron-builder 25).

## Artifacts produced (final, slim build)

Latest release: **v1.3.1** — export is now a plain copy + rename (flat by
default, Scene folders optional), the Export window no longer dies on a dead
ZIP-era call, and the build needs no wine.

| File | Size | Target | Icon | Version info |
| --- | --- | --- | --- | --- |
| `Fusion Flix Clip Renamer & Sorter Setup.exe` | 89,604,289 bytes (85.4 MB) | NSIS installer (x64) | ✅ embedded (7 sizes) | ✅ `ProductName`, `CompanyName` (Dhruv Sharma), `LegalCopyright`, `FileVersion 1.3.1` |
| `dist/win-unpacked/Fusion Flix Clip Renamer & Sorter.exe` | 188,811,264 bytes | the installed application | ✅ | ✅ `1.3.1` |
| `dist/… 1.3.1.exe` | ~85 MB | portable (x64) — `npm run build:portable` | ✅ | ✅ |

```
sha256  89,604,289 bytes
922d39caaf35bc8d60ccb94695557e83ce3927a6175acdc6645227f243e83aaa
```

Installer payload (verified with 7-Zip): `Fusion Flix Clip Renamer & Sorter.exe`
(188,811,264 B), `resources/app.asar`, `resources/ffmpeg/ffprobe.exe`
(63,059,968 B) and the app's own README — 21 files, ~304 MB unpacked.

### Test status (v1.3.1 tree)

```
npm test                     106 / 106 pass
electron tests/e2e.js        224 passed, 0 failed
node tools/check-asar.js     214 entries, 26 required runtime files, engine found
```

The e2e run boots the real app in a virtual display and drives the actual UI:
it imports/loads clips, exports flat **and** into Scene folders, opens the Export
window, checks both layout options, presses its real EXPORT button and inspects
the files that land on disk (including "the copy is a real duplicate, not a hard
link" and "no report file is written").

### Built without wine

The previous Linux-hosted release depended on wine twice: for stamping
`rcedit.exe` resources and for pre-building the uninstaller. Both steps are gone
— icon/version stamping now happens in JavaScript (`packaging/after-pack.js`
with `resedit`, plus `win.signAndEditExecutable: false`), and the uninstaller is
written at install time by NSIS' `WriteUninstaller` from the custom script
`packaging/installer.nsi`. The build therefore runs on any Linux/macOS box:
`npm install && npm run build:win`, no wine, mono or Windows runtime.

### Why the size dropped from 191 MB to 87 MB

The first build bundled `ffmpeg-static` and `ffprobe-static` as npm packages.
Those resolve to the **building machine's platform**, so a Linux build shipped a
Linux `ffmpeg` binary that could never run on Windows — it was 80 MB of dead
weight, plus a 60 MB `ffprobe.exe`.

The release build now:

* excludes both npm packages from `app.asar` (see `electron-builder.yml`)
* ships one deliberate Windows binary, `resources/ffmpeg/ffprobe.exe`, which
  supplies durations, resolution, frame rates and **embedded source timecodes**
* generates thumbnails inside the renderer when FFmpeg is absent — verified by
  `tests/media-fallback.js`
* includes four 4-second placeholder clips (357 KB) so *Load Sample Project*
  works on a machine with no FFmpeg at all
* ships only the `en-US` Electron locale

Adding `ffmpeg.exe` (Settings → Media engine → Locate, or dropped into the
`ffmpeg` folder) enables background thumbnail extraction with a disk cache and
the live sample generator. Nothing about the workflow is blocked without it.

Both are `PE32+ executable for MS Windows (GUI), x86-64`. Icon embedding was
verified byte-for-byte against the 256 px PNG frame inside `icons/icon.ico`.

> These binaries are not stored in the source tree — `dist/` is a build output
> folder. Recreate them at any time with `npm run build:win` (≈2 min) or
> `npm run build:portable` (≈4 min).

## Package contents check

```
$ node tools/check-asar.js
check-asar: 214 entries in app.asar
  ok  26 required runtime files present
  ok  media engine binaries found in dist/win-unpacked/resources/ffmpeg (1)
```

## Test results

```
$ npm test
# tests 56   # pass 56   # fail 0

$ xvfb-run -a npx electron tests/e2e.js
  111 passed, 0 failed

$ xvfb-run -a npx electron tests/media-fallback.js
  8/8 fallback checks passed
```

The end-to-end harness boots the real application (same `main.js`, same
renderer) and exercises the complete workflow against a real filesystem:

* boot, sandboxed preload bridge, shared naming library inside the renderer
* sample-clip generation + import with FFmpeg metadata probing
* virtualised clip browser, thumbnails streamed over `ffthumb:`
* tagging, live filename preview, `APPLY & NEXT`
* `NEXT FROM PREVIOUS` independence for Scene / Shot / Take (and the first-clip rule)
* undo / redo
* custom name overriding the standard filename while metadata is preserved
* folder export (flat by default; Scene folders optional, never Shot/Take folders; sources untouched)
* ZIP export (`Fusion_Flix_Clips.zip`, structure verified with `unzip -Z1`)
* export never overwrites an existing file; blocked clips do not stop the run
* project save / reopen with metadata restored
* missing media detection + relink
* delete confirmation — clip leaves the project, source file stays on disk
* search, filters, sorting
* no renderer exceptions and no CSP violations
* **v1.1.0:** hover shows the floating preview *and* loads the clip into the main
  preview (muted, never clobbering pending edits); Space plays with any field
  focused but not while typing a custom name; `F` carries Scene/Shot/Take forward;
  the Daylight theme + custom accent reach the CSS variables; focus view really
  fills the window (measured, not just "not display:none"); a fresh import is
  tagged `S-1_SH-1_T-1`; checkbox-only Settings edits persist; closing Settings
  with an armed key button releases capture so shortcuts stay alive; a remap
  works and the old key stops responding

### Bugs found and fixed by these tests (for the record)

1. Modal footer buttons were never attached to the DOM — every dialog (delete,
   export, settings) was unusable.
2. Switching clips kept stale Scene/Shot/Take values in the panel.
3. Undo/redo restored the data but the panel (and filename preview) did not
   repaint while a field still had focus.
4. The `file timestamp` timecode fallback produced `00-00-00` because the file
   mtime was not passed to the naming engine.
5. FFmpeg could not write thumbnails to the temporary `.part` file (unknown
   container) — the temp name now ends in `.jpg` and an explicit muxer is set.
6. A missing-source-file export reported success instead of `failed`.

### v1.1.0 bugs found while building the release

7. **Hover cancelled itself**: `selectClip()` stopped the floating preview, so the
   moment hover pre-rolled a clip into the main preview the small preview vanished.
   Selection now keeps it (`keepHover`), a stray `mouseout` from a recycled row can
   no longer cancel another row's hover, and recycled rows reset their hover state.
8. **Focus view showed an empty stage**: hiding the side panes made the preview
   slide into the browser's zero-width grid column. The three panes now have
   explicit `grid-column` values. (Caught by the screenshot pass, not by the
   original `display !== 'none'` assertion — the e2e check now measures the panes.)
9. **Settings dropped checkbox-only edits**: only the old `<select>`s fed the draft
   form, so toggling "Take default OFF" and saving silently did nothing. The panel
   now reads the whole form on save and on every change.
10. **Closing Settings with an armed key button killed every shortcut** — the
    capture state stayed on. Closing the panel (✕ or CANCEL) now releases it, and an
    unsaved live theme preview is reverted.
11. **Test-harness flaws**: the fallback suite depended on a `PATH` ffmpeg and could
    hang forever (it now uses the bundled binary, has a watchdog and fails loudly),
    and the e2e reported a bare "Script failed to execute" instead of naming the
    snippet that broke.

## Environment notes

* Building the Windows targets from Linux requires **wine** (both 32-bit and
  64-bit flavours — electron-builder uses the 32-bit `rcedit` internally).
* On Windows itself no extra tooling is needed beyond Node.js.
* `npm install` downloads Electron, `ffmpeg-static`, `ffprobe-static`,
  `archiver` and `electron-builder`; the application itself never needs a
  network connection at runtime.
