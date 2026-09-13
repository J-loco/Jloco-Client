'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  state: () => ipcRenderer.invoke('launcher:state'),
  setSettings: (patch) => ipcRenderer.invoke('launcher:setSettings', patch),
  check: (opts) => ipcRenderer.invoke('launcher:check', opts),
  cancel: () => ipcRenderer.invoke('launcher:cancel'),
  play: () => ipcRenderer.invoke('launcher:play'),
  news: () => ipcRenderer.invoke('launcher:news'),
  status: () => ipcRenderer.invoke('launcher:status'),
  selfUpdate: (info) => ipcRenderer.invoke('launcher:selfUpdate', info),
  pickInstallPath: () => ipcRenderer.invoke('launcher:pickInstallPath'),
  openInstallPath: () => ipcRenderer.invoke('launcher:openInstallPath'),
  openExternal: (url) => ipcRenderer.invoke('launcher:openExternal', url),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  onEvent: (cb) => ipcRenderer.on('update:event', (_e, msg) => cb(msg))
});
