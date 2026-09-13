'use strict';
// Local-tree verification against a remote manifest.
//
// Manifest shape (see tools/build-manifest.js):
//   { version, generatedAt, filesPath?, launcher?: {version,file,sha1},
//     files: { "<relative/path>": { size, sha1 } }, delete?: ["<relative/path>"] }
//
// Hashing 1.4 GB on every start would be unusable, so a quick pass trusts a
// (size, mtime) cache and only hashes files whose stat changed. "Repair" forces
// a full re-hash of every file in the manifest.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

class HashCache {
  constructor(file) {
    this.file = file;
    this.dirty = false;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      this.data = {};
    }
  }
  get(rel, stat) {
    const hit = this.data[rel];
    if (!hit) return null;
    if (hit.size !== stat.size || hit.mtimeMs !== stat.mtimeMs) return null;
    return hit.sha1;
  }
  set(rel, stat, sha1) {
    this.data[rel] = { size: stat.size, mtimeMs: stat.mtimeMs, sha1 };
    this.dirty = true;
  }
  flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
      this.dirty = false;
    } catch (err) {
      // A cache we cannot persist is a slow next start, not a failure.
    }
  }
}

// Reject paths that would escape the install root (a hostile manifest must not
// be able to write into C:\Windows via "../../..").
function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  const prefix = path.resolve(root) + path.sep;
  if (full !== path.resolve(root) && !full.startsWith(prefix)) {
    throw new Error('manifest path escapes install root: ' + rel);
  }
  return full;
}

async function diff(manifest, installPath, options = {}) {
  const { full = false, cacheFile = null, onProgress = null, signal = null } = options;
  const cache = cacheFile ? new HashCache(cacheFile) : null;
  const entries = Object.entries(manifest.files || {});

  const needed = [];
  let neededBytes = 0;
  let checked = 0;
  let okCount = 0;

  for (const [rel, meta] of entries) {
    if (signal && signal.aborted) throw new Error('aborted');
    const file = safeJoin(installPath, rel);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      stat = null;
    }

    let need = false;
    if (!stat || !stat.isFile()) {
      need = true;
    } else if (stat.size !== meta.size) {
      need = true;
    } else {
      const cached = full || !cache ? null : cache.get(rel, stat);
      const sha1 = cached || (await sha1File(file));
      if (cache && !cached) cache.set(rel, stat, sha1);
      need = sha1 !== meta.sha1;
    }

    if (need) {
      needed.push({ path: rel, size: meta.size, sha1: meta.sha1 });
      neededBytes += meta.size;
    } else {
      okCount++;
    }

    checked++;
    if (onProgress && (checked % 25 === 0 || checked === entries.length)) {
      onProgress({ checked, total: entries.length, path: rel });
    }
  }

  if (cache) cache.flush();

  const stale = [];
  for (const rel of manifest.delete || []) {
    const file = safeJoin(installPath, rel);
    if (fs.existsSync(file)) stale.push(rel);
  }

  return { needed, neededBytes, stale, okCount, total: entries.length };
}

module.exports = { diff, sha1File, safeJoin, HashCache };
