'use strict';
// Persistent launcher settings + the resolved install root.
//
// The install root is the directory that holds "Dofus Retro.exe" and resources/.
// Packaged, that is the launcher exe's own directory (the launcher ships *inside*
// the client install). In dev, it is the repo root two levels above launcher/.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  installPath: null,          // null => auto-detect (see defaultInstallPath)
  arch: 'modern-x64',         // 'modern-x64' (Electron host) | 'legacy-x86' (Flash projector)
  afterLaunch: 'minimize',    // 'minimize' | 'close' | 'nothing'
  autoCheck: true,            // check for updates on startup
  remoteBase: null            // null => value from launcher.config.json
};

function appRoot() {
  // src/main/settings.js -> src/main -> src -> launcher
  return path.resolve(__dirname, '..', '..');
}

function bundledConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot(), 'launcher.config.json'), 'utf8'));
  } catch (err) {
    return {};
  }
}

function defaultInstallPath() {
  if (app.isPackaged) return path.dirname(app.getPath('exe'));
  return path.resolve(appRoot(), '..');
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

let cache = null;

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (err) {
    stored = {};
  }
  cache = Object.assign({}, DEFAULTS, stored);
  return cache;
}

function save(patch) {
  const next = Object.assign({}, load(), patch || {});
  cache = next;
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

function resolved() {
  const s = load();
  const cfg = bundledConfig();
  return {
    ...s,
    ...cfg,
    remoteBase: (s.remoteBase || cfg.remoteBase || '').replace(/\/+$/, ''),
    installPath: s.installPath || defaultInstallPath(),
    launcherVersion: app.getVersion()
  };
}

function remoteUrl(rel) {
  const r = resolved();
  return r.remoteBase + '/' + String(rel).replace(/^\/+/, '');
}

module.exports = { load, save, resolved, remoteUrl, defaultInstallPath, appRoot, DEFAULTS };
