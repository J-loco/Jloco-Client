#!/usr/bin/env node
'use strict';
// Generates the update manifest the launcher consumes, and (with --copy) stages
// the changed files for upload.
//
//   node tools/build-manifest.js                      # manifest only, into dist-update/
//   node tools/build-manifest.js --copy               # + stage changed files under dist-update/files/
//   node tools/build-manifest.js --version 2026.09.13 # pin a version label
//   node tools/build-manifest.js --root <dir> --out <dir>
//
// Upload dist-update/ to the web host so that:
//   <remoteBase>/manifest.json      is this manifest
//   <remoteBase>/files/<rel/path>   is each file
//
// Re-running is cheap: file hashes are cached in dist-update/.hashcache.json by
// (size, mtime), and --copy only stages files whose hash actually changed.

const fs = require('fs');
const path = require('path');
const { sha1File } = require('../src/main/manifest');

const CONCURRENCY = 8;

// Everything that is per-machine, source-only, or regenerated on the dev box.
// resources/app/node_modules is part of the shipped Dofus Electron application:
// preloader.js needs bytenode to load main.jsc, and main.jsc uses other runtime
// packages. Excluding every node_modules directory produces a broken x64 install.
const EXCLUDE_DIRS = new Set(['.git', 'launcher', 'dist-update']);
const EXCLUDE_FILES = [
  /^\.gitignore$/,
  /^\.gitattributes$/,
  /^CLAUDE\.md$/,
  /^README\.md$/,
  /\.part$/,
  /^hs_err_pid\d+\.log$/,
  /flashsettingslocalhost\.sol$/,
  /^JLoco Launcher\.exe$/,
  /^\.release\.hashes\.json$/
];

function parseArgs(argv) {
  const out = { copy: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--copy') out.copy = true;
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--version') out.version = argv[++i];
    else if (a === '--launcher') out.launcher = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

function walk(root, rel = '') {
  const dir = path.join(root, rel);
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      if (
        entry.name === 'node_modules' &&
        childRel !== 'resources/app/node_modules' &&
        !childRel.startsWith('resources/app/node_modules/')
      ) {
        continue;
      }
      out.push(...walk(root, childRel));
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.some((re) => re.test(entry.name) || re.test(childRel))) continue;
      out.push(childRel);
    }
  }
  return out;
}

function defaultVersion() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 18).join('\n'));
    return;
  }

  const root = path.resolve(args.root || path.join(__dirname, '..', '..'));
  const out = path.resolve(args.out || path.join(__dirname, '..', 'dist-update'));
  const version = args.version || defaultVersion();

  if (!fs.existsSync(path.join(root, 'resources', 'app', 'retroclient'))) {
    throw new Error('--root does not look like a JLoco client tree: ' + root);
  }
  fs.mkdirSync(out, { recursive: true });

  const cacheFile = path.join(out, '.hashcache.json');
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch (err) {
    cache = {};
  }

  let previous = { files: {} };
  try {
    previous = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  } catch (err) {
    previous = { files: {} };
  }

  const rels = walk(root);
  console.log('scanning ' + rels.length + ' files in ' + root);

  let hashed = 0;
  let done = 0;
  const entries = await mapLimited(rels, CONCURRENCY, async (rel) => {
    const file = path.join(root, rel);
    const stat = fs.statSync(file);
    const hit = cache[rel];
    let sha1;
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
      sha1 = hit.sha1;
    } else {
      sha1 = await sha1File(file);
      cache[rel] = { size: stat.size, mtimeMs: stat.mtimeMs, sha1 };
      hashed++;
    }
    done++;
    if (done % 500 === 0) process.stdout.write('  hashed ' + done + '/' + rels.length + '\r');
    return [rel, { size: stat.size, sha1 }];
  });

  const files = Object.fromEntries(entries.sort((a, b) => a[0].localeCompare(b[0])));
  const removed = Object.keys(previous.files || {}).filter((rel) => !files[rel]);

  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    filesPath: 'files',
    files,
    delete: removed
  };

  if (args.launcher) {
    const exe = path.resolve(args.launcher);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    manifest.launcher = {
      version: pkg.version,
      file: path.basename(exe),
      sha1: await sha1File(exe)
    };
    fs.copyFileSync(exe, path.join(out, path.basename(exe)));
  }

  let staged = 0;
  if (args.copy) {
    for (const [rel, meta] of Object.entries(files)) {
      const prev = (previous.files || {})[rel];
      const dest = path.join(out, 'files', rel);
      if (prev && prev.sha1 === meta.sha1 && fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(root, rel), dest);
      staged++;
    }
    for (const rel of removed) {
      fs.rmSync(path.join(out, 'files', rel), { force: true });
    }
  }

  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
  fs.writeFileSync(cacheFile, JSON.stringify(cache));

  const totalBytes = Object.values(files).reduce((n, f) => n + f.size, 0);
  console.log(
    '\nmanifest ' + version + ': ' + rels.length + ' files, ' + (totalBytes / 1048576).toFixed(1) + ' MB' +
    ' (' + hashed + ' newly hashed, ' + removed.length + ' removed' + (args.copy ? ', ' + staged + ' staged' : '') + ')'
  );
  console.log('written to ' + out);
}

main().catch((err) => {
  console.error('build-manifest failed: ' + (err.message || err));
  process.exit(1);
});
