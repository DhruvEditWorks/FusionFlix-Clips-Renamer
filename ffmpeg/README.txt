# FFmpeg / FFprobe drop-in folder

Fusion Flix Clip Renamer & Sorter needs two executables to read video metadata
and build thumbnails: **ffmpeg** and **ffprobe**.

## What the released Windows build ships (v1.3.0)

The installer puts **`ffprobe.exe`** in the installed app's
`resources\ffmpeg\` folder. That alone gives clip durations, resolution, frame
rate and the embedded source timecode — the values that go into the filename —
completely offline.

`ffmpeg.exe` is offered as an **optional download at install time** (and any
time later from **Settings → Media engine → Download FFmpeg**). It adds:

* background thumbnail extraction for every camera codec, including HEVC/H.265,
  ProRes and DNxHD,
* the built-in sample project generator,
* full-size still frames for clips Windows itself cannot decode.

The app never requires it: with FFprobe only, thumbnails are generated inside
the app for the codecs the system can decode, and renaming, tagging, sorting and
export all work exactly the same. Nothing is ever sent anywhere — the download
only happens when you ask for it, straight from the official FFmpeg mirrors.

Layout after installation:

```
<install folder>\
└── resources\
    └── ffmpeg\
        ├── ffprobe.exe    bundled with the installer
        ├── ffmpeg.exe     optional download (installer or Settings)
        └── README.txt     this file
```

## Building the release yourself

`npm run sync` (run automatically by `npm run build:win`, `npm start` and
`npm test`) stages the Windows **FFprobe** from `node_modules/ffprobe-static`
into this folder, and electron-builder copies the folder into
`resources\ffmpeg\` of the packaged app.

Add these flags when you also want the 80 MB FFmpeg binary inside the installer:

```
npm run build:win -- --with-ffmpeg       # or:  FF_SHIP_FULL_ENGINE=1 npm run build:win
```

Without the flag the binary is deliberately left out to keep the download
slim; users get it through the installer's dependency step or Settings.

You can always drop the files in by hand instead — a manually placed
`ffmpeg.exe` / `ffprobe.exe` here is used as-is and never overwritten:

```
ffmpeg/
├── ffmpeg.exe     (optional — thumbnails for every codec + sample generator)
├── ffprobe.exe    (shipped — durations, resolution, FPS, source timecodes)
└── README.txt     (this file)
```

Get them from a trusted static build (for example
https://www.gyan.dev/ffmpeg/builds/ "release essentials" or
https://github.com/BtbN/FFmpeg-Builds). FFmpeg is licensed separately
(LGPL/GPL) by the FFmpeg project — see https://ffmpeg.org/legal.html.

For development (`npm start`) `npm install` pulls `ffmpeg-static` and
`ffprobe-static`, which the app finds automatically.

Binary search order at runtime:

1. `FFMPEG_PATH` / `FFPROBE_PATH` environment variables
2. the paths chosen in Settings → Media engine
3. `resources/ffmpeg/` inside the installed application (this folder)
4. the per-user engine folder (`%APPDATA%\Fusion Flix Clip Renamer & Sorter\ffmpeg`) —
   where the installer's optional download and Settings → Download FFmpeg put things
5. `node_modules/ffmpeg-static` and `node_modules/ffprobe-static`
6. `ffmpeg` / `ffprobe` on the system PATH
