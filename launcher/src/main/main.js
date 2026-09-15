'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const settings = require('./settings');
const launcherApi = require('./api');
const { launch, resolve: resolveGame } = require('./launch');
const { Updater } = require('./updater');

let win = null;
let updater = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 620,
    resizable: false,
    frame: false,
    backgroundColor: '#0f1218',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });

  // External links open in the real browser, never in the launcher window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  updater = new Updater((type, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('update:event', { type, payload });
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('launcher:state', () => {
  const cfg = settings.resolved();
  const game = resolveGame(cfg.installPath, cfg.arch);
  return { settings: cfg, game: { ok: game.ok, exe: game.exe, reason: game.reason || null } };
});

ipcMain.handle('launcher:setSettings', (_e, patch) => {
  settings.save(patch || {});
  const cfg = settings.resolved();
  const game = resolveGame(cfg.installPath, cfg.arch);
  return { settings: cfg, game: { ok: game.ok, exe: game.exe, reason: game.reason || null } };
});

ipcMain.handle('launcher:check', (_e, opts) => updater.check(opts || {}));
ipcMain.handle('launcher:cancel', () => {
  updater.cancel();
  return true;
});
ipcMain.handle('launcher:selfUpdate', (_e, info) => updater.selfUpdate(info));

ipcMain.handle('launcher:play', () => {
  const cfg = settings.resolved();
  const result = launch(cfg.installPath, cfg.arch);
  if (win && !win.isDestroyed()) {
    if (cfg.afterLaunch === 'close') app.quit();
    else if (cfg.afterLaunch === 'minimize') win.minimize();
  }
  return result;
});

ipcMain.handle('launcher:news', async () => {
  try {
    return { ok: true, items: await launcherApi.news() };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('launcher:status', async () => {
  try {
    return { ok: true, status: await launcherApi.status() };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('launcher:pickInstallPath', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Select the JLoco client folder',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  settings.save({ installPath: res.filePaths[0] });
  return res.filePaths[0];
});

ipcMain.handle('launcher:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
});

ipcMain.handle('launcher:openInstallPath', () => shell.openPath(settings.resolved().installPath));

ipcMain.on('window:minimize', () => win && win.minimize());
ipcMain.on('window:close', () => app.quit());
