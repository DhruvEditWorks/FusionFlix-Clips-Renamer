# Fusion Flix — Clip Renamer & Sorter

## 1.3.3

**"Preview still not visible — the Fusion Flix welcome screen stays on top."**

* Root cause found and reproduced: after an import, the clip list filled up but
  the first-run overlay stayed over the player. The import flow ended with
  `App.updateProjectMeta()`, a helper that was **never exported** on
  `window.FFApp` — so it threw a `TypeError` and the import's remaining steps
  (auto-select the first clip, hide the welcome panel) were skipped. The clips
  were there, the preview was covered. Selecting a clip by hand did nothing
  either, because the overlay is painted above the player.
* Fixed the missing export, moved the selection step **before** the cosmetic
  summary, and added a guard: the clip-list renderer and every clip selection
  now re-check the overlay, so no future code path can leave the player covered.
* New audit test: every `App.<helper>` called from the panels/UI is checked
  against what the app actually exports (that is the class of bug that caused
  this), plus a regression test for the import → overlay order.
* Verified by screenshot on a real Electron window: import two clips → the
  overlay disappears, the first clip plays, and an HEVC clip plays through its
  preview copy.

## 1.3.2

**Preview finally works for real camera footage.**

* Root cause, reproduced: the player component Chromium ships cannot decode
  HEVC/H.265, ProRes, DNxHD or 10-bit/4:2:2 footage. An H.264 test clip played
  fine (`readyState 4`); an HEVC clip came back with
  `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`, which is why selecting a clip painted an
  empty player.
* New **preview proxy**: when a clip cannot be decoded, the app builds a small
  H.264 stand-in for that one clip (`lib/media.js → ensureProxy`) and plays that
  instead — timeline, scrubbing, hover shuttle and playback all work. The
  original file is only ever read. Proxies are cached per file (path + size +
  mtime), reused instantly, and cleared from Settings → Maintenance.
* If the media engine (FFmpeg) is not installed, the player now says exactly
  that, names the codec it found, and offers **INSTALL MEDIA ENGINE** in place —
  instead of showing a black rectangle. The welcome screen does the same, and
  the Settings download flow is now shared by all three entry points.
* Windows hardware HEVC decoding is requested (`PlatformHEVCDecoderSupport` +
  accelerated video decode), so many camera files play natively without a
  proxy at all.
* A clip whose file was moved/renamed/unplugged is reported as
  **"This clip could not be read"** with a RELINK button, instead of being
  mistaken for a codec problem.
* The installer's media-engine step now explains that the engine is what makes
  previews and thumbnails of camera codecs work (and stays optional).

**Naming:** the bracket carries Scene, Shot and Take — nothing else.

* `S-1_SH-5_T-15_(1-5-15).mp4`, `…_EXTRA_(1-5-15).mp4`
* A switched-off tag contributes `0` (`S-1_SH-5_(1-5-0).mp4`), and a completely
  untagged clip keeps its own name (`clip_01_(0-0-0).mov`).
* The source timecode is no longer part of the filename element; it stays on the
  clip as metadata. Custom Name still overrides everything.

Tests: 116 unit checks + 235 end-to-end checks (including a real HEVC clip that
is imported, proxied and played back inside the app).

Installer: `Fusion Flix Clip Renamer & Sorter Setup.exe`
(89,609,523 bytes, sha256 `aba1763267a09464bad12354a44f30596d98691e1855cb1526bb70173e8a6ea2`).
