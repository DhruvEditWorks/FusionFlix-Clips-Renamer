# Building the Windows executable

Everything needed to turn this project into a Windows `.exe` is included.
No code changes are required.

---

## 1. On Windows (simplest)

Install [Node.js 18+](https://nodejs.org) (64-bit), then in this folder:

```bat
npm install
npm run build:win
```

`npm run sync` runs first and stages the Windows **FFprobe** into `./ffmpeg`
(see §5). Add `-- --with-ffmpeg` to embed the full 80 MB FFmpeg engine in the
installer as well.

Result:

```
dist\
├── Fusion Flix Clip Renamer & Sorter Setup.exe     ← installer (~90 MB)
└── win-unpacked\
    └── Fusion Flix Clip Renamer & Sorter.exe       ← the application itself
```

`npm run build:portable` additionally produces
`dist\Fusion Flix Clip Renamer & Sorter 1.3.0.exe` — a single file that runs
without installing (handy for a USB stick on a shoot).

Double-click the installer → choose a folder → desktop + Start-menu shortcuts
are created with the Fusion Flix icon and the window title
*“Fusion Flix Clip Renamer & Sorter”*.

**Requirements:** Windows 10 or 11, 64-bit. The application itself is fully
offline — no account, no server, no internet connection at any point.

---

## 2. Cross-building from Linux or macOS (no wine needed)

```bash
npm install          # also stages ./ffmpeg/ffprobe.exe (see §5)
npm run build:win
```

That is the whole recipe: a Linux or macOS machine produces the identical
Windows installer, **without wine, mono or any Windows runtime**.

How the wine dependency was removed (worth knowing before changing the
packaging files):

| Step that normally needs wine | What this project does instead |
| --- | --- |
| Stamping the icon + version info into the `.exe` (electron-builder shells out to `rcedit.exe`) | `packaging/after-pack.js` writes the resources in pure JavaScript with `resedit`, and `win.signAndEditExecutable: false` turns rcedit off |
| Pre-building the uninstaller (electron-builder *runs* the installer as a Windows binary and lets it `WriteUninstaller`) | `packaging/installer.nsi` (our copy of the stock script) embeds `packaging/uninstaller-stub.exe`, and `packaging/installer.nsh` calls NSIS' `WriteUninstaller` at install time — the classic NSIS pattern |

Notes for maintainers:

* `packaging/installer.nsi` also defines `customCheckAppRunning`, because the
  stock "is the app running?" check uses a function name that differs between
  installer and uninstaller, which cannot compile when both live in one script.
* `packaging/uninstaller-stub.exe` is only a placeholder — it is overwritten on
  the user's machine at install time. Rebuild it after editing its source with
  `npm run uninstaller-stub` (uses the makensis in the electron-builder cache,
  no install needed).
* If you change a version of electron-builder, re-run `npm run build:win` once
  and check the log for `uninstaller is not signed by electron-builder` — that
  line proves the wine step was skipped.

Installing wine is therefore optional, not required. If you do build on
Windows itself, everything behaves exactly as documented above.

## 3. Build targets

| Script | Target | Purpose |
| --- | --- | --- |
| `npm run build:win` | NSIS installer | normal distribution |
| `npm run build:portable` | portable exe | no installation required |
| `npm run build:dir` | unpacked folder | fastest; use while developing |
| `npm run build:ia32` | 32-bit | only if a machine still runs 32-bit Windows |
| `npm run build:all` | both | installer + portable in one go |
| `npm run icons` | — | redraws `icons/icon.ico` + PNGs |
| `npm run uninstaller-stub` | — | rebuilds `packaging/uninstaller-stub.exe` |

Output always lands in `dist/`. All NSIS work lives in `packaging/`
(`installer.nsi` = the script, `installer.nsh` = the hooks: uninstaller
generation, registry, optional engine download, `uninstaller-stub.*` = the
placeholder uninstaller), and everything else lives in `electron-builder.yml`:
app id, product name, icon, shortcuts, artifact names, ASAR unpack rules and
the FFmpeg resources.

---

## 4. What the released installer contains

`dist/Fusion Flix Clip Renamer & Sorter Setup.exe` — **~90 MB** — bundles:

* the Electron runtime (~200 MB unpacked, installed to
  `%LOCALAPPDATA%\Programs\Fusion Flix Clip Renamer & Sorter`)
* the application (`app.asar`, ~2 080 files)
* `resources/ffmpeg/ffprobe.exe` — clip durations, resolution, frame rates and
  **embedded source timecodes** work with no setup at all
* `assets/sample-clips/` — four tiny placeholder clips (357 KB total, generated
  from FFmpeg pattern sources) so **Load Sample Project** works even when FFmpeg
  is not installed

Thumbnails do **not** depend on FFmpeg: if `ffmpeg.exe` is absent the renderer
captures a frame from the clip itself and paints it to a canvas. Installing
FFmpeg (Settings → Media engine → **Locate FFmpeg…**, or a file dropped into the
`ffmpeg` folder) switches on background thumbnail extraction with a disk cache
and the live sample generator.

`./ffmpeg/ffprobe.exe` is staged automatically by `npm run sync` (which runs
before every build, and on `npm install`) from the `ffprobe-static` npm
package — it is deliberately *not* committed to the repository to keep it
small. `npm run sync:clean` removes it again; `npm run sync` brings it back
with no manual download. To pin your own build, simply drop
`ffmpeg.exe`/`ffprobe.exe` into `./ffmpeg` — hand-placed files always win.

Packaging deliberately excludes `node_modules/ffmpeg-static` and
`ffprobe-static`: those resolve to the *building* machine's platform, so a Linux
build would otherwise ship a Linux binary that cannot run on Windows. Windows
binaries arrive through the `ffmpeg/` folder instead, which is copied to
`resources/ffmpeg/` verbatim.

## 5. What ends up inside the package

```
Fusion Flix Clip Renamer & Sorter\
├── Fusion Flix Clip Renamer & Sorter.exe   (Electron shell, ~188 MB)
├── resources\
│   ├── app.asar                          (application code, ~2 080 files)
│   └── ffmpeg\
│       └── ffprobe.exe                   ← bundled media engine
├── locales\ (en-US only), *.dll, icudtl.dat, …
```

Verify a package at any time with:

```bash
node tools/check-asar.js
```

It confirms that every runtime file is present in `app.asar` and that the
FFmpeg binaries were unpacked where they can actually execute.

---

## 6. Icon

`icons/icon.ico` is a genuine multi-resolution Windows icon (16, 24, 32, 48,
64, 128 and 256 px) generated by `npm run icons` — it is drawn procedurally by
`tools/make-icons.js`, so there are no third-party logo assets involved. It is
used for the `.exe`, the installer, the uninstaller, the desktop shortcut, the
Start-menu entry and the taskbar.

Regenerate or restyle it with:

```bash
npm run icons
```

---

## 7. Before you ship (optional polish)

* **Code signing** — an unsigned installer triggers SmartScreen the first time.
  With a certificate, add to `electron-builder.yml`:

  ```yaml
  win:
    signtoolOptions:
      certificateFile: path/to/cert.pfx
      certificatePassword: ${env.CSC_KEY_PASSWORD}
  ```

* **Version bump** — edit `version` in `package.json`; it flows into the
  installer name, the file properties and the About dialog automatically.

---

*Fusion Flix Clip Renamer & Sorter — A free to use tool by Fusion Flix (Dhruv Sharma) 💓*
