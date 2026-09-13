# StarLoco - Client

Client version : 1.39.8 electron remastered

A patched Dofus 1.39.8 desktop client. The game itself is Flash (AS2) shipped as
`resources/app/retroclient/loader.swf`; this repo wraps it in an Electron host
(`Dofus Retro.exe`) that embeds a bundled PepperFlash runtime. A 32-bit standalone
Flash projector (`retroclient/Dofus.exe`) is also shipped for legacy machines.

---

## Two launch paths (x64 Electron vs x86 legacy)

`zaap.yml` is the **Ankama Launcher (Zaap)** manifest. On Windows it exposes an
*Architecture* setting with two mutually-exclusive executables:

| Setting | Executable | Runtime |
|---|---|---|
| `modern-x64` (default) | `Dofus Retro.exe` | **Electron**, 64-bit. Wraps Flash via the bundled 64-bit `resources/app/pepperflash/pepflashplayer.dll`. |
| `legacy-x86` | `resources/app/retroclient/Dofus.exe` | Standalone **32-bit Flash projector**. **Does not use Electron at all** — no `preloader.js`, no `main.jsc`, no BrowserWindow. Opens `loader.swf` with embedded 32-bit Flash. |

```yaml
# zaap.yml (Windows)
winVer == 'modern-x64'  → executable: "Dofus Retro.exe"
winVer == 'legacy-x86'  → executable: "resources/app/retroclient/Dofus.exe"
```

Both paths read the same game assets in `resources/app/retroclient/`
(`loader.swf`, `config.xml`, `data/`, …), so they behave identically in-game.
macOS has the equivalent split (`x64` app bundle vs the 32-bit `Flash Player`
inside `retroclient/Dofus.app`).

> Verified PE machine types: `Dofus Retro.exe` and `pepflashplayer.dll` are `0x8664`
> (x64); `retroclient/Dofus.exe` and `cache.exe` are `0x14c` (x86).

---

## Electron boot chain ("behind the hood of `Dofus Retro.exe`")

```
Dofus Retro.exe                         (electron runtime, 64-bit — renamed electron.exe)
 └─ resources/app/package.json          "main": "preloader.js"
     └─ preloader.js                     bootstrap shim
         ├─ if main.jsc exists → require("bytenode"); require("main.jsc")   ← production
         └─ else if process.defaultApp && main.js → require("main.js")       ← dev fallback
             main.jsc = the real main process (compiled V8 bytecode)
              ├─ registers PepperFlash (pepperflash/pepflashplayer.dll) via the
              │   flash-player-loader / nw-flash-trust-a deps, plugins enabled
              └─ creates a BrowserWindow that loads:
                  resources/app/retroclient/D1ElectronLauncher.html
                   ├─ <script src="js/D1ElectronLauncher.js">   (renderer logic)
                   └─ <object data="preloader.swf?electron=yes"> (Flash plugin)
                        └─ preloader.swf → loader.swf            ← the actual game
```

Supporting windows / assets in `retroclient/`:
- `D1Chat.html` / `js/D1Chat.js` — detachable chat window
- `D1Console.html` / `js/D1Console.js` — debug console
- `mms.cfg` — locks Flash to local files (`AllowListUrlPattern=file:*`, auto-update disabled)
- `config.xml` — server IP/port and data source

### Key directories

```
StarLoco-Client/
├─ Dofus Retro.exe                 # Electron runtime (x64)
├─ zaap.yml                        # Ankama Launcher manifest (x64 vs x86 selector)
├─ resources/
│  ├─ app.asar / app/              # the Electron app (this build ships an unpacked app/)
│  │  ├─ package.json              # "main": "preloader.js"
│  │  ├─ preloader.js              # bootstrap shim (jsc → js fallback)
│  │  ├─ main.jsc                  # COMPILED main process (bytenode/V8 bytecode)
│  │  ├─ pepperflash/              # bundled 64-bit PepperFlash DLL
│  │  ├─ node_modules/             # flash-player-loader, nw-flash-trust-a, discord-rpc, …
│  │  └─ retroclient/              # the game payload (shared by both launch paths)
│  │     ├─ loader.swf             # the actual game (AS2, obfuscated)
│  │     ├─ preloader.swf          # tiny SWF that loads loader.swf
│  │     ├─ config.xml             # server endpoint + cacheAsBitmap settings
│  │     ├─ Dofus.exe / cache.exe  # 32-bit standalone projector (legacy-x86 path)
│  │     ├─ D1ElectronLauncher.html / .js
│  │     ├─ D1Chat.html / D1Console.html
│  │     └─ data/  audio/  clips/  css/  fonts/  svg/ …
```

---

## What's editable vs. locked

| Layer | File(s) | How to edit |
|---|---|---|
| **Server endpoint** | `retroclient/config.xml` | Plain XML. Change `<connserver ip="…" port="…">` and `<dataserver url="…">`. Applies to **both** launch paths. Easiest, most common edit. |
| **Game logic / UI** | `retroclient/loader.swf` | JPEXS Free Flash Decompiler, **P-Code tab** (see *SWF modding* below). |
| **Renderer (Chromium side)** | `retroclient/js/D1ElectronLauncher.js`, `*.html` | Plain (webpack-minified) JS/HTML — edit directly, loads at runtime, no rebuild. Same for `D1Chat.*`, `D1Console.*`. |
| **App metadata** | `resources/app/package.json` | Plain JSON. |
| **Flash policy** | `resources/app/mms.cfg` | Plain text. |
| **Main process** | `resources/app/main.jsc` | **Compiled** (bytenode/V8, tied to this exact Electron/V8 build). Not directly editable — see below. |

### SWF modding (`loader.swf`)

Source is AS2 with heavy obfuscation (classes renamed to `_SafeStr_NNN`, members
bracket-accessed with non-printable string keys like `this.api["\x1c\x16\n"]`).
**Use JPEXS Free Flash Decompiler, P-Code tab — not the decompiled ActionScript:**

1. Open `loader.swf` in JPEXS.
2. Navigate the script tree to the target class (e.g. `dofus._SafeStr_0.gapi.ui.StatsJob`).
3. Edit on the **P-Code** tab instruction-by-instruction. Preserve labels that are jump
   targets (`locXXXX:`) — they're referenced by `If`/`Jump` offsets elsewhere.
4. In-pane **Save** to commit the P-Code change, then **File → Save** to write the SWF.

JPEXS' AS2 recompiler is sometimes lossy with obfuscated string-keyed member accesses
and can break runtime lookups; P-Code edits preserve the constant pool verbatim.

### Modifying the compiled main process (`main.jsc`)

`main.jsc` is bytenode-compiled (V8 bytecode tied to this Electron/V8 build), so you
can't open and edit it directly. `preloader.js` provides the supported escape hatch:

```js
if (fs.existsSync("main.jsc")) { require("main.jsc"); }          // taken in production
else if (process.defaultApp && fs.existsSync("main.js")) { ... } // dev path
```

`process.defaultApp` is `true` only when Electron is launched with a path argument
(not as a packaged app). To run/modify the main process in dev:

1. Install matching Electron in `resources/app` (`npm i -D electron@<version>`, matching
   the bundled runtime), **or** launch `Dofus Retro.exe` with the app path so
   `defaultApp` is set.
2. Temporarily rename `main.jsc` so the shim falls through, and drop a readable `main.js`.
3. `cd resources/app && npx electron .` — now `main.js` is loaded; you can change window
   flags, Flash registration, the loaded HTML path, IPC, etc.

The original `main.js` source is **not** shipped (only the `.jsc`), so a from-scratch
main-process change means authoring a new `main.js` or disassembling the bytecode —
usually not worth it. In practice almost everything you'd want lives in the un-compiled
layers: `config.xml` (server), `loader.swf` (gameplay/UI), and
`D1ElectronLauncher.js/.html` (window/renderer behavior). Reserve `main.jsc` work for
things only the Node/main process controls (window chrome, Flash DLL path, IPC,
single-instance, auto-update).

---

## How to run it

- **As shipped (x64):** double-click `Dofus Retro.exe`. It auto-loads
  `resources/app` → `retroclient`.
- **Legacy 32-bit:** run `resources/app/retroclient/Dofus.exe` directly (bypasses
  Electron entirely).
- **Dev (editable main):** `cd resources/app && npx electron .` after the rename / `main.js`
  step above.
- **Point it at your server:** edit `retroclient/config.xml` `connserver` / `dataserver`
  — works for both the Electron and legacy-x86 paths. The default targets
  `127.0.0.1:450` with `http://127.0.0.1/dofus/` as the data server.

---

## Stat-boost client/server contract

Relevant when modding `StatsJob`: the client sends `AS<stat>` (single +1) or
`AS<stat>|<quantity>` (multi). Both are handled server-side in
`StarLoco-Game/src/org/starloco/locos/game/GameClient.java#boost`
(`Player.boostStat` / `Player.boostStatFixedCount`).

**Applied patch — StatsJob "always show quantity popup" (2026-05-21):**
In `dofus._SafeStr_0.gapi.ui.StatsJob`, function `click`, inside the `_btn10`–`_btn15`
handler block, label `loc1277` originally held `Not` + `If loc13cc` (which skipped the
popup when no modifier key was held). Replacing it with a single `Pop` discards the
boolean and falls through unconditionally to the popup, so every click opens the
quantity dialog. The label `loc1277` must be kept — it is a jump target from `loc1423`.
