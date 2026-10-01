'use strict';
/**
 * FUSION FLIX — afterPack hook: stamps the Windows app icon + version info.
 *
 * electron-builder normally shells out to `rcedit.exe` through wine to do this.
 * That makes a Linux/macOS build depend on a working wine installation — which
 * is fragile (a broken wine silently produces an icon-less, version-less exe,
 * or fails the build outright). Instead we do the same job in pure JavaScript
 * with `resedit`, which is already part of electron-builder's own dependency
 * tree, so a cross-build needs nothing but Node.
 *
 * Runs automatically (see electron-builder.yml → afterPack) right after the app
 * is packed into dist/win-unpacked and *before* the NSIS installer is created,
 * so the installer ships the stamped executable.
 *
 * Both parts are best-effort: a stamping failure never fails the build, it only
 * warns — the app still runs, it would just keep the default Electron icon.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let resedit = null;
try {
  resedit = require('resedit');
} catch (_) {
  resedit = null;
}

function log(message) {
  process.stdout.write(`after-pack: ${message}\n`);
}

/** Reads the icon as a resedit IconFile, tolerating any .ico variant. */
function loadIcon(iconPath) {
  const buffer = fs.readFileSync(iconPath);
  return resedit.Data.IconFile.from(buffer);
}

/**
 * Replaces every icon resource of the executable (all group ids and languages)
 * with the ones from our .ico, so Explorer, the taskbar and the shortcuts show
 * the Fusion Flix mark.
 */
function stampIcon(executable, resource, iconFile) {
  const groups = resedit.Resource.IconGroupEntry.fromEntries(resource.entries);
  const icons = iconFile.icons.map((item) => item.data);
  if (!groups.length) {
    // No icon resources at all (unusual) — add a standard one.
    resedit.Resource.IconGroupEntry.replaceIconsForResource(resource.entries, 1, 1033, icons);
    return 1;
  }
  let stamped = 0;
  for (const group of groups) {
    resedit.Resource.IconGroupEntry.replaceIconsForResource(
      resource.entries,
      group.id,
      group.lang || 1033,
      icons
    );
    stamped += 1;
  }
  void executable;
  return stamped;
}

/** Writes the version strings the way rcedit --set-version-string would. */
function stampVersion(resource, info) {
  const versions = resedit.Resource.VersionInfo.fromEntries(resource.entries);
  const vi = versions.length ? versions[0] : resedit.Resource.VersionInfo.createEmpty();
  const lang = vi.getDefaultVersionLang ? vi.getDefaultVersionLang() : 1033;
  const language = vi.getAllLanguagesForStringValues && vi.getAllLanguagesForStringValues().length
    ? vi.getAllLanguagesForStringValues()[0]
    : { lang: 1033, codepage: 1200 };
  vi.setStringValues({ lang: language.lang, codepage: language.codepage }, info.strings);
  const parts = info.version.split('.').map((n) => Number(n) || 0);
  while (parts.length < 4) parts.push(0);
  vi.setFileVersion(parts[0], parts[1], parts[2], parts[3], lang);
  vi.setProductVersion(parts[0], parts[1], parts[2], parts[3], lang);
  vi.outputToResourceEntries(resource.entries);
}

/**
 * @param {import('app-builder-lib').AfterPackContext} context
 */
exports.default = async function afterPack(context) {
  if (!resedit) {
    log('resedit is unavailable — skipping icon/version stamping (the app still runs).');
    return;
  }
  if (context.electronPlatformName !== 'win32') return;

  const appInfo = context.packager.appInfo;
  const outDir = context.appOutDir;
  const executableName = `${appInfo.productFilename}.exe`;
  const target = path.join(outDir, executableName);
  if (!fs.existsSync(target)) {
    log(`no executable found at ${target} — nothing stamped.`);
    return;
  }

  const iconPath = path.join(context.packager.projectDir, 'icons', 'icon.ico');
  const info = {
    version: appInfo.version,
    strings: {
      FileDescription: appInfo.description || 'Fusion Flix Clip Renamer & Sorter',
      ProductName: appInfo.productName,
      CompanyName: 'Dhruv Sharma',
      LegalCopyright: `Copyright © ${new Date().getFullYear()} Fusion Flix (Dhruv Sharma)`,
      LegalTrademarks: 'Fusion Flix',
      InternalName: appInfo.productName,
      OriginalFilename: executableName,
      FileVersion: appInfo.version,
      ProductVersion: appInfo.version,
      Comments: 'A free to use tool by Fusion Flix (Dhruv Sharma)',
    },
  };

  try {
    const executable = resedit.NtExecutable.from(fs.readFileSync(target), { ignoreCert: true });
    const resource = resedit.NtExecutableResource.from(executable);

    let iconGroups = 0;
    if (fs.existsSync(iconPath)) {
      iconGroups = stampIcon(executable, resource, loadIcon(iconPath));
    } else {
      log(`icon not found at ${iconPath} — version info only.`);
    }
    stampVersion(resource, info);

    resource.outputResource(executable);
    const output = Buffer.from(executable.generate());
    fs.writeFileSync(target, output);
    log(
      `stamped ${path.basename(target)} — ${iconGroups} icon group(s), version ${appInfo.version}, ${(
        output.length / (1024 * 1024)
      ).toFixed(1)} MB`
    );
  } catch (err) {
    log(`stamping failed (${(err && err.message) || err}) — the build continues with the default icon.`);
  }

  // electron-builder names helper executables after the app on some targets.
  for (const extra of fs.readdirSync(outDir)) {
    if (!extra.endsWith('.exe') || extra === executableName) continue;
    const extraPath = path.join(outDir, extra);
    try {
      const executable = resedit.NtExecutable.from(fs.readFileSync(extraPath), { ignoreCert: true });
      const resource = resedit.NtExecutableResource.from(executable);
      stampVersion(resource, Object.assign({}, info, { strings: Object.assign({}, info.strings, { OriginalFilename: extra }) }));
      resource.outputResource(executable);
      fs.writeFileSync(extraPath, Buffer.from(executable.generate()));
      log(`stamped version info on ${extra}`);
    } catch (_) {
      /* helper executables are optional */
    }
  }
};
