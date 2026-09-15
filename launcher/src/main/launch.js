'use strict';
// Starts the game. Mirrors the executable choice that zaap.yml makes for Zaap:
//   modern-x64 -> "Dofus Retro.exe"                       (Electron host + PepperFlash)
//   legacy-x86 -> resources/app/retroclient/Dofus.exe     (32-bit Flash projector)
// Both read the same payload in resources/app/retroclient, so they behave the
// same in game; the legacy path just loses the Electron extras.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TARGETS = {
  'modern-x64': {
    rel: 'Dofus Retro.exe',
    cwd: '.',
    required: [
      path.join('resources', 'app', 'preloader.js'),
      path.join('resources', 'app', 'main.jsc'),
      path.join('resources', 'app', 'node_modules', 'bytenode', 'lib', 'index.js')
    ]
  },
  'legacy-x86': { rel: path.join('resources', 'app', 'retroclient', 'Dofus.exe'), cwd: path.join('resources', 'app', 'retroclient') }
};

function isLfsPointer(file) {
  // An un-pulled LFS object is a ~130 byte text file, not an executable.
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64);
    const read = fs.readSync(fd, buf, 0, 64, 0);
    fs.closeSync(fd);
    return buf.slice(0, read).toString('utf8').startsWith('version https://git-lfs');
  } catch (err) {
    return false;
  }
}

function resolve(installPath, arch) {
  const target = TARGETS[arch] || TARGETS['modern-x64'];
  const exe = path.join(installPath, target.rel);
  const cwd = path.join(installPath, target.cwd);

  if (!fs.existsSync(exe)) {
    return { ok: false, exe, cwd, reason: 'Executable not found: ' + exe };
  }
  if (isLfsPointer(exe)) {
    return {
      ok: false,
      exe,
      cwd,
      reason:
        path.basename(exe) +
        ' is a Git LFS pointer, not the real binary. Run "git lfs pull" in the client repo, or let the launcher download it.'
    };
  }
  for (const rel of target.required || []) {
    const requiredFile = path.join(installPath, rel);
    if (!fs.existsSync(requiredFile)) {
      return {
        ok: false,
        exe,
        cwd,
        reason: 'Required x64 runtime file is missing: ' + rel + '. Run Verify / repair files.'
      };
    }
  }
  return { ok: true, exe, cwd };
}

function launch(installPath, arch) {
  const target = resolve(installPath, arch);
  if (!target.ok) throw new Error(target.reason);

  const child = spawn(target.exe, [], {
    cwd: target.cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
  return { pid: child.pid, exe: target.exe };
}

module.exports = { launch, resolve, TARGETS };
