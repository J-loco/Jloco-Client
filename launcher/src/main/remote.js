'use strict';
// Thin HTTP helpers over Node's global fetch (Electron >= 22 / Node >= 18).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

class HttpError extends Error {
  constructor(status, url) {
    super('HTTP ' + status + ' for ' + url);
    this.status = status;
    this.url = url;
  }
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new HttpError(res.status, url);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, ms = 15000) {
  const res = await fetchWithTimeout(url, ms);
  return res.json();
}

// Download `url` to `dest`, streaming through a sha1 check.
// onChunk(bytes) reports incremental progress. Returns the computed sha1.
async function downloadFile(url, dest, { onChunk, timeout = 120000, expectedSha1 = null } = {}) {
  const res = await fetchWithTimeout(url, timeout);
  const tmp = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const hash = crypto.createHash('sha1');
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      if (onChunk) onChunk(chunk.length);
      cb(null, chunk);
    }
  });

  try {
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }

  const sha1 = hash.digest('hex');
  if (expectedSha1 && sha1 !== expectedSha1) {
    fs.rmSync(tmp, { force: true });
    throw new Error('checksum mismatch for ' + url + ' (got ' + sha1 + ', expected ' + expectedSha1 + ')');
  }

  // Atomic-ish swap: rename over the target, retrying once if the file is locked.
  try {
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    fs.renameSync(tmp, dest);
  }
  return sha1;
}

module.exports = { fetchJson, downloadFile, HttpError };
