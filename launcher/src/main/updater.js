'use strict';
// Update engine: fetch manifest -> verify local tree -> download what differs.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const settings = require('./settings');
const { fetchJson, downloadFile } = require('./remote');
const { diff, safeJoin } = require('./manifest');

const CONCURRENCY = 6;
const RETRIES = 3;

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

class Updater {
  constructor(emit) {
    this.emit = emit;
    this.busy = false;
    this.controller = null;
    this.manifest = null;
  }

  cancel() {
    if (this.controller) this.controller.abort();
  }

  fileUrl(manifest, rel) {
    const base = (manifest.filesPath || settings.resolved().filesPath || 'files').replace(/\/+$/, '');
    const encoded = rel.split('/').map(encodeURIComponent).join('/');
    return settings.remoteUrl(base + '/' + encoded);
  }

  async check({ full = false } = {}) {
    if (this.busy) return { status: 'busy' };
    this.busy = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const cfg = settings.resolved();

    try {
      this.emit('phase', { phase: 'checking', message: 'Contacting update server...' });
      const manifest = await fetchJson(settings.remoteUrl(cfg.manifestPath || 'manifest.json'));
      if (!manifest || typeof manifest.files !== 'object') {
        throw new Error('malformed manifest (no "files" map)');
      }
      this.manifest = manifest;

      const launcherUpdate =
        manifest.launcher && compareVersions(app.getVersion(), manifest.launcher.version) < 0
          ? manifest.launcher
          : null;

      this.emit('phase', { phase: 'verifying', message: 'Verifying game files...', version: manifest.version });
      const plan = await diff(manifest, cfg.installPath, {
        full,
        cacheFile: path.join(app.getPath('userData'), 'hashcache.json'),
        signal,
        onProgress: (p) =>
          this.emit('verify', { checked: p.checked, total: p.total, path: p.path })
      });

      if (!plan.needed.length && !plan.stale.length) {
        this.emit('phase', {
          phase: 'ready',
          message: 'Game is up to date.',
          version: manifest.version,
          launcherUpdate
        });
        return { status: 'ready', version: manifest.version, plan, launcherUpdate };
      }

      this.emit('phase', {
        phase: 'downloading',
        message: 'Downloading update...',
        files: plan.needed.length,
        bytes: plan.neededBytes,
        version: manifest.version
      });
      await this.download(manifest, plan, cfg.installPath, signal);

      for (const rel of plan.stale) {
        try {
          fs.rmSync(safeJoin(cfg.installPath, rel), { force: true });
        } catch (err) {
          // A file we cannot remove is not worth failing the whole update over.
        }
      }

      this.emit('phase', {
        phase: 'ready',
        message: 'Update complete.',
        version: manifest.version,
        launcherUpdate
      });
      return { status: 'updated', version: manifest.version, plan, launcherUpdate };
    } catch (err) {
      const aborted = signal.aborted;
      this.emit('phase', {
        phase: aborted ? 'idle' : 'error',
        message: aborted ? 'Update cancelled.' : String(err.message || err)
      });
      return { status: aborted ? 'cancelled' : 'error', error: String(err.message || err) };
    } finally {
      this.busy = false;
      this.controller = null;
    }
  }

  async download(manifest, plan, installPath, signal) {
    const queue = plan.needed.slice();
    const totalBytes = plan.neededBytes;
    const totalFiles = queue.length;
    let doneBytes = 0;
    let doneFiles = 0;
    let lastTick = 0;
    const startedAt = Date.now();

    const report = (force) => {
      const now = Date.now();
      if (!force && now - lastTick < 120) return;
      lastTick = now;
      const elapsed = Math.max(1, now - startedAt) / 1000;
      this.emit('progress', {
        doneBytes,
        totalBytes,
        doneFiles,
        totalFiles,
        bytesPerSecond: doneBytes / elapsed
      });
    };

    const worker = async () => {
      while (queue.length) {
        if (signal.aborted) throw new Error('aborted');
        const item = queue.shift();
        const dest = safeJoin(installPath, item.path);
        let attempt = 0;
        for (;;) {
          attempt++;
          const before = doneBytes;
          try {
            await downloadFile(this.fileUrl(manifest, item.path), dest, {
              expectedSha1: item.sha1,
              onChunk: (n) => {
                doneBytes += n;
                report(false);
              }
            });
            break;
          } catch (err) {
            doneBytes = before; // discard the partial transfer's progress
            if (signal.aborted) throw new Error('aborted');
            if (attempt >= RETRIES) throw new Error(item.path + ': ' + (err.message || err));
            await new Promise((r) => setTimeout(r, 400 * attempt));
          }
        }
        doneFiles++;
        this.emit('file', { path: item.path, doneFiles, totalFiles });
        report(false);
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, totalFiles)) }, worker));
    report(true);
  }

  // Fetch the new launcher installer and hand it to the OS, then quit so the
  // installer can replace our own exe.
  async selfUpdate(info) {
    const dest = path.join(app.getPath('temp'), info.file);
    this.emit('phase', { phase: 'downloading', message: 'Downloading launcher ' + info.version + '...' });
    await downloadFile(settings.remoteUrl(info.file), dest, { expectedSha1: info.sha1 || null });
    const { shell } = require('electron');
    await shell.openPath(dest);
    app.quit();
  }
}

module.exports = { Updater, compareVersions };
