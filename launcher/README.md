# StarLoco Launcher

Electron launcher + patcher for the StarLoco client. Replaces the Ankama Launcher
(Zaap): it verifies the local install against a manifest you publish, downloads only
what changed, shows news and server status, and starts the game.

It ships **inside** the client install, next to `Dofus Retro.exe`.

## Why it exists

`zaap.yml` is a Zaap manifest, not runtime config: it only tells Zaap which files to
download and which executable to start (`modern-x64` → `Dofus Retro.exe`,
`legacy-x86` → `resources/app/retroclient/Dofus.exe`). Without Zaap there is nothing to
patch an install. This launcher reproduces both halves — the update mechanism and the
executable choice — against your own web host.

## Layout

```
launcher/
├─ launcher.config.json     # remote endpoints baked into the build
├─ src/main/
│  ├─ main.js               # window, IPC
│  ├─ settings.js           # userData settings + install-root resolution
│  ├─ manifest.js           # local verify / diff (size+mtime hash cache)
│  ├─ updater.js            # fetch manifest, download queue, self-update
│  ├─ remote.js             # fetch + streaming download with sha1 check
│  ├─ launch.js             # spawns the game per architecture
│  └─ api.js                # news + status
├─ src/preload.js           # contextBridge -> window.launcher
├─ src/renderer/            # UI (no framework)
└─ tools/build-manifest.js  # deploy-side manifest generator
```

## Develop

```bash
cd launcher
npm install
npm start          # installPath defaults to the repo root (the client tree)
```

## Publish an update

1. Change whatever you want in the client tree (`resources/app/retroclient/...`,
   `config.xml`, even `Dofus Retro.exe`).
2. Regenerate the manifest and stage the changed files:
   ```bash
   cd launcher
   node tools/build-manifest.js --copy
   ```
   Output lands in `launcher/dist-update/` (`manifest.json` + `files/`). Hashes are
   cached by (size, mtime), so re-runs only hash what you touched, and `--copy` only
   stages files whose hash actually changed.
3. Upload `dist-update/` to `<docroot>/launcher/` on the web host (see
   `StarLoco-Web/launcher/README.md`). rsync works well:
   ```bash
   rsync -av --delete dist-update/ user@host:/var/www/html/launcher/
   ```
4. Players get it on their next launch. Files removed from the tree are listed in the
   manifest's `delete` array and are deleted client-side.

Point the launcher at your host by editing `launcher.config.json` before packaging
(`remoteBase`, `siteUrl`, `registerUrl`, `discordUrl`).

## Ship the launcher itself

```bash
npm run dist                                   # -> dist/StarLoco-Launcher-1.0.0.exe
node tools/build-manifest.js --copy --launcher dist/StarLoco-Launcher-1.0.0.exe
```

`--launcher` copies the installer next to the manifest and records its version + sha1
under `manifest.launcher`. A running launcher on an older version shows
**UPDATE LAUNCHER** instead of **PLAY**: it downloads the installer, verifies the hash,
runs it, and quits so the exe can be replaced.

Bump `version` in `package.json` for each launcher release — the comparison is numeric
per dot-segment.

### Windows: enable Developer Mode before `npm run dist`

Packaging the app directory works out of the box (`dist/win-unpacked/StarLoco Launcher.exe`
runs as-is), but building the **NSIS installer** fails on this machine with:

```
ERROR: Cannot create symbolic link : ... winCodeSign\<id>\darwin\10.12\lib\libcrypto.dylib
```

electron-builder unpacks its `winCodeSign` bundle, which contains macOS symlinks, and creating
symlinks on Windows needs a privilege a normal user does not have. Pre-extracting the cache does
not help — each run extracts into a new randomly-named directory. Fix it once, either way:

- **Settings → System → For developers → Developer Mode: On** (grants `SeCreateSymbolicLinkPrivilege`), or
- run `npm run dist` from an **elevated** terminal.

Until then, `dist/win-unpacked/` is a complete, runnable launcher — zip it if you just need to
hand someone a build.

## Notes

- **Verify vs repair.** A normal check trusts a (size, mtime) cache in `userData` and
  only hashes files whose stat changed; hashing all 19k files takes minutes.
  *Settings → Verify / repair all files* forces a full re-hash.
- **Path safety.** Manifest paths are resolved against the install root and rejected if
  they escape it, so a compromised manifest cannot write outside the game folder.
- **Downloads** run 6 at a time, stream straight to `<file>.part`, are checked against
  the manifest sha1, and are renamed over the target only on match. 3 retries with
  backoff.
- **Excluded from updates:** `.git/`, `node_modules/`, `launcher/`, `dist-update/`,
  `CLAUDE.md`, `README.md`, `hs_err_pid*.log`, `flashsettingslocalhost.sol`, and the
  launcher exe itself (which updates through `manifest.launcher` instead).
