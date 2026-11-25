'use strict';

// electron-builder `afterPack` hook: harden the packaged Electron binary by
// flipping runtime fuses. This closes the "RunAsNode" / inspector attack surface
// (an attacker who can set ELECTRON_RUN_AS_NODE or --inspect on the shipped exe
// can otherwise reuse Electron as an arbitrary Node interpreter).
//
// Wired from electron-builder.yml (`afterPack: scripts/after-pack.js`), which is
// the active electron-builder config for this project (there is no `build` field
// in package.json; adding one would shadow the yml entirely).

const fs = require('node:fs');
const path = require('node:path');

const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/**
 * Locate the packaged Electron executable. electron-builder names it from the
 * productName (e.g. `服务器轮询监测工具.exe`); build-portable.ps1 renames it to
 * `servermonitor.exe` later, so we must resolve it by the product filename here
 * and fall back to the largest non-backend .exe in the output directory.
 *
 * @param {{appOutDir: string, packager?: object, electronPlatformName?: string}} context
 * @returns {string|null}
 */
function resolveExecutable(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const ext = electronPlatformName === 'darwin' ? '' : '.exe';
  const productFilename = packager && packager.appInfo && packager.appInfo.productFilename;
  if (productFilename) {
    const named = path.join(appOutDir, `${productFilename}${ext}`);
    if (fs.existsSync(named)) {
      return named;
    }
  }
  if (!ext) {
    return null;
  }
  let candidates;
  try {
    candidates = fs
      .readdirSync(appOutDir)
      .filter((name) => name.toLowerCase().endsWith(ext) && !/backend/i.test(name))
      .map((name) => {
        const full = path.join(appOutDir, name);
        return { full, size: fs.statSync(full).size };
      })
      .sort((a, b) => b.size - a.size);
  } catch (error) {
    return null;
  }
  return candidates.length > 0 ? candidates[0].full : null;
}

async function afterPack(context) {
  const electronPath = resolveExecutable(context);
  if (!electronPath) {
    throw new Error('after-pack: could not locate the packaged Electron executable to flip fuses');
  }

  await flipFuses(electronPath, {
    version: FuseVersion.V1,
    // Disable ELECTRON_RUN_AS_NODE: the shipped app must never behave as a Node CLI.
    [FuseV1Options.RunAsNode]: false,
    // Disable --inspect / NODE_OPTIONS debugging of the production binary.
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // Encrypt cookies at rest in the OS keychain.
    [FuseV1Options.EnableCookieEncryption]: true,
  });

  console.log(`[after-pack] flipped Electron fuses on ${electronPath}`);
}

module.exports = afterPack;
module.exports.default = afterPack;
