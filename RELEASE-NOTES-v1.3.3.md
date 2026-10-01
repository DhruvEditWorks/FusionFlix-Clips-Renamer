## Fusion Flix — Clip Renamer &amp; Sorter 1.3.3

**Download:** `Fusion Flix Clip Renamer & Sorter Setup.exe`
**Size:** 89,609,890 bytes · **SHA-256:** `a3911b91090284a6b9ae52c9327bd60177179de8cadde1ac8bfc6891077a77a3`

Windows 10/11 64-bit · normal user install (no admin needed) · fully offline.

---

### 🔧 Fixed — “preview still not visible, the Fusion Flix screen stays on top”

This was the real bug behind an empty player, and it had nothing to do with codecs:

After an import, the clip list filled up but the first-run welcome overlay stayed painted
over the player. The import flow ended with `App.updateProjectMeta()` — a helper that was
**never exported** on `window.FFApp`. It threw a `TypeError`, the import's `try/catch`
swallowed it, and the remaining import steps (auto-select the first clip, hide the welcome
panel) never ran. Clicking a clip did nothing either, because the overlay sits above the
player.

* the missing export is fixed
* the selection step now happens **before** the cosmetic summary, so a failure in a small
  helper can never cover the player again
* the clip-list renderer and every clip selection re-check the overlay, so no future code
  path can leave it up
* **new audit test:** every `App.<helper>` the panels/UI call is checked against what the app
  actually exports — the exact class of bug that caused this
* verified by screenshot on a real Electron window: import → overlay gone → first clip plays

### 🎥 Preview copies for camera codecs

Windows playback only understands H.264, VP9 and AV1. HEVC/H.265, ProRes, DNxHD and 10-bit
footage therefore could not be shown at all. Now:

* if the machine can decode the clip in hardware (HEVC included), it plays natively —
  the app asks Chromium for `PlatformHEVCDecoderSupport`
* otherwise, with FFmpeg available, the app builds a small **H.264 preview copy of that one
  clip** (cached per file, reused instantly) and plays it — timeline, scrubbing, hover
  shuttle and playback all work
* originals are **only read** — never changed, moved or deleted
* if FFmpeg is missing, the player says so, names the codec it found, and offers a
  one-click **INSTALL MEDIA ENGINE**; the welcome screen offers the same
* a clip whose file was moved/renamed/unplugged is reported as *“This clip could not be
  read”* with a **RELINK** button instead of being mistaken for a codec problem

### 🏷 Naming — the bracket is Scene, Shot and Take, nothing else

| Situation | Result |
| --- | --- |
| Scene 1, Shot 5, Take 15 | `S-1_SH-5_T-15_(1-5-15).mp4` |
| …marked as an extra | `S-1_SH-5_T-15_EXTRA_(1-5-15).mp4` |
| …with Take switched off | `S-1_SH-5_(1-5-0).mp4` |
| …completely untagged | `clip_01_(0-0-0).mov` |
| …with a custom name | `Opening Drone Shot.mp4` (S/SH/T stay in the project) |

The source timecode is no longer part of the filename; it stays on the clip as metadata.

### 📦 Installer

The optional media-engine step at install time now explains what the engine is *for*
(previews and thumbnails of camera codecs) and stays optional, as before.

---

**Checks:** 118 unit tests + 239 end-to-end checks (including a real HEVC clip imported,
proxied and played back inside the app) — all green.

A free to use tool by Fusion Flix (Dhruv Sharma) 💓 · [youtube.com/@fusiononyoutube](https://youtube.com/@fusiononyoutube)
