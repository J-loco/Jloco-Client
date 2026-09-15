# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

StarLoco is a Dofus 1.39 private-server emulator split into four sub-projects:

| Sub-project | Language | Role |
|---|---|---|
| `StarLoco-Game` | Java 21 (Gradle) | Game server — core gameplay, fights, world state |
| `StarLoco-Login` | Java 8 (Gradle) | Authentication server — account login, server list |
| `StarLoco-Client` | Electron (JS) | Patched Dofus 1.39.8 desktop client |
| `StarLoco-Web` | PHP | Web portal — registration, shop, ladder |

## Build & Run

### Game server (Java 21 + Amazon Corretto)
```bash
cd StarLoco-Game
./gradlew jar          # produces build/libs/game.jar
./build.sh             # gradle jar + copies game.jar to project root
java -jar game.jar     # or start.bat on Windows
```
Config: `game.config.properties` (or via `STARLOCO_CONFIG_PATH` env var)

### Login server (Java 8)
```bash
cd StarLoco-Login
./gradlew jar          # produces build/libs/login.jar
java -jar login.jar    # or start.bat on Windows
```
Config: `login.config.properties`

Database setup: create `starloco_login` DB and run `login.sql`. Game DB: create `starloco_game` and run `game.sql`.

### Docker (full stack)
```bash
cd StarLoco-Game
docker compose -f docker-compose.yml up
```
This spins up MariaDB, Redis, the login image, and builds+runs the game image. Config overrides live in `StarLoco-Game/config/`.

## Architecture

### Packet protocol
Both servers use Apache MINA with a newline+NUL text codec. Packets are 2-character header strings followed by payload (e.g. `"AT"`, `"GJ"`). The Game server routes packets two ways:
1. **New-style** (`DofusMessageFactory` + `EventDispatcherFactory`): classes annotated with `@DofusMessage(header="XX")` are discovered via reflection; dispatched through `AbstractEventMessageDispatcher` subclasses annotated with `@Handler`.
2. **Legacy** (`client.parsePacket()`): a large switch/dispatch in `GameClient`.

### Game server internals (`StarLoco-Game/src/org/starloco/locos/`)
- **`kernel/`** — `Main` (entry point, main loop), `Config` (all config properties), `Logging`
- **`game/`** — `GameServer` (MINA acceptor), `GameHandler` (session lifecycle), `GameClient` (per-connection state + legacy packet dispatch), `game/world/World` (singleton world state: players, maps, NPCs, guilds)
- **`database/`** — `DatabaseManager` manages two HikariCP pools (login DB + game DB). Each entity type has a `DAO<T>` subclass under `database/data/game/` or `database/data/login/`. DAOs are registered and retrieved via `DatabaseManager.get(SomeData.class)`.
- **`script/`** — Lua scripting via the `classdump/luna` JVM-Lua runtime. `ScriptVM` is the base; `DataScriptVM` (singleton) loads static game data (NPCs, maps, XP tables, admin commands, animations) from `scripts/Data.lua` + subdirectories. Scripts can be plain directories or `.zip` archives.
- **`fight/`** — `Fight`, `Fighter` hierarchy (`PlayerFighter`, `MobFighter`, `SummonFighter`, etc.), spell system, IA (monster AI), traps, turns.
- **`entity/`** — monsters, NPCs, mounts, pets, collectors, prisms.
- **`area/`** — `GameMap`, `GameCase` (cells), pathfinding, sub-areas.
- **`exchange/`** — `ExchangeClient` connects game server to login server over a private TCP channel on port 666 (key-authenticated). The login server runs a matching `ExchangeServer`.

### Login server internals (`StarLoco-Login/src/org/starloco/locos/`)
- **`login/`** — `LoginServer` accepts client connections; `LoginHandler`/packet classes handle authentication flow (version check → account name → password → server selection).
- **`exchange/`** — `ExchangeServer` listens for game-server connections; `PacketHandler` routes inter-server messages (server state updates, player counts).
- **`database/`** — single MariaDB connection (`Database`), DAOs for accounts, players, servers.

### Lua scripts (`StarLoco-Game/scripts/`)
- `Common.lua` — shared utilities, loaded first by every VM.
- `Data.lua` — entry point for static data; uses `LoadPack()` to load subdirectories (`data/`, `models/`, `eventhandlers/`).
- `Java.lua` — Java interop helpers exposed to scripts.
- `data/` — NPC definitions, map definitions, experience tables, admin commands/groups, animations, dungeons, etc.
- `eventhandlers/` — Lua-side event handlers registered via `Handlers` (the `EventHandlers` object injected into the VM).
- `models/` — reusable Lua model definitions.

### Web portal (`StarLoco-Web/`)
PHP app with a single front controller (`index.php`) routing via `?page=<name>`. PDO connects to both the login DB and game DB. Pages live in `pages/`, shared classes in `class/`, config in `configuration/`.

### Electron host & launch paths (`StarLoco-Client/`)

The client ships **two ways to run**, selected by the Ankama Launcher (Zaap) manifest `zaap.yml` via a Windows *Architecture* setting:

| Setting | Executable | Runtime |
|---|---|---|
| `modern-x64` (default) | `Dofus Retro.exe` | **Electron** (64-bit; a renamed `electron.exe`). Wraps Flash via the bundled 64-bit `resources/app/pepperflash/pepflashplayer.dll`. |
| `legacy-x86` | `resources/app/retroclient/Dofus.exe` | Standalone **32-bit Flash projector**. **Does not use Electron** — no `preloader.js`, `main.jsc`, or BrowserWindow. Opens `loader.swf` with embedded 32-bit Flash. |

Both paths read the same payload in `resources/app/retroclient/` (`loader.swf`, `config.xml`, `data/`, …), so they behave identically in-game. Verified PE machine types: `Dofus Retro.exe` + `pepflashplayer.dll` are `0x8664` (x64); `retroclient/Dofus.exe` + `cache.exe` are `0x14c` (x86).

**Electron boot chain (the x64 path):**
```
Dofus Retro.exe                       (electron runtime)
 └─ resources/app/package.json        "main": "preloader.js"
     └─ preloader.js                   bootstrap shim:
         ├─ if main.jsc → require("bytenode"); require("main.jsc")   ← production
         └─ else if process.defaultApp && main.js → require("main.js") ← dev fallback
             main.jsc = real main process (compiled V8 bytecode)
              ├─ registers PepperFlash via flash-player-loader / nw-flash-trust-a deps
              └─ BrowserWindow loads retroclient/D1ElectronLauncher.html
                  ├─ <script src="js/D1ElectronLauncher.js">    (renderer)
                  └─ <object data="preloader.swf?electron=yes">  (Flash plugin)
                       └─ preloader.swf → loader.swf             ← the game
```
Sibling renderer windows: `D1Chat.html`/`js/D1Chat.js` (detachable chat), `D1Console.html`/`js/D1Console.js` (debug console). `mms.cfg` locks Flash to local files (`AllowListUrlPattern=file:*`).

**What's editable vs locked:**
- **`retroclient/config.xml`** — plain XML; server endpoint (`<connserver ip port>`, `<dataserver url>`). Applies to *both* launch paths; default `127.0.0.1:450`. Most common edit.
- **`retroclient/loader.swf`** — gameplay/UI; edit via JPEXS P-Code (see SWF modding below).
- **`retroclient/js/D1ElectronLauncher.js` + `*.html`** — plain (webpack-minified) renderer JS/HTML; edit directly, no rebuild.
- **`resources/app/package.json`, `mms.cfg`** — plain text.
- **`resources/app/main.jsc`** — **compiled** (bytenode/V8 bytecode, tied to this exact Electron build); not directly editable.

**Editing the compiled main process:** `preloader.js` falls back to a readable `main.js` only when `process.defaultApp` is true (Electron launched with a path arg, not packaged). To dev: install matching `electron@<version>` in `resources/app`, temporarily rename `main.jsc`, drop a `main.js`, then `cd resources/app && npx electron .`. The original `main.js` is not shipped, so prefer the un-compiled layers (`config.xml`, `loader.swf`, `D1ElectronLauncher.js`) for almost all changes; reserve `main.jsc` for window chrome / Flash DLL path / IPC / single-instance / auto-update.

**Run modes:** double-click `Dofus Retro.exe` (x64); run `retroclient/Dofus.exe` directly (legacy x86); `cd resources/app && npx electron .` (dev). Point at a server by editing `retroclient/config.xml`.

### Launcher & update deployment (`launcher/`)

**`zaap.yml` is not runtime config.** It is an Ankama Launcher (Zaap) manifest: it declares
download *fragments* and picks which executable Zaap starts. Nothing is passed to the client
at run time — no args, no env, no generated config. `.release.hashes.json` lists the fragments
actually installed here (`configuration`, `main`, `windows`, `remastered`), so this tree is the
complete Windows/remastered pack and **double-clicking `Dofus Retro.exe` is a valid way to run**.
Real runtime config is `retroclient/config.xml` alone (verified by inflating `loader.swf`, which
references `config.xml`, `connserver`, `dataserver`, `rcount`, `loadingbanners`, `menuadmin.xml`/
`rc-menuadmin.xml`).

`launcher/` replaces Zaap with our own Electron launcher + patcher. It ships inside the install,
next to `Dofus Retro.exe`.

- `tools/build-manifest.js` walks the client tree and writes `dist-update/manifest.json`
  (`{version, files: {path: {size, sha1}}, delete: [...]}`); `--copy` also stages changed files
  into `dist-update/files/`. Both sides cache hashes by (size, mtime) — a full scan of the tree
  is ~22.5k files / 666 MB. Unlike source-only dependency folders,
  `resources/app/node_modules/` is included because the x64 Electron client needs `bytenode`
  to load `main.jsc` and uses the other packages at runtime.
- The launcher verifies locally, downloads only differing files (6 at a time, sha1-checked,
  written to `<file>.part` then renamed), deletes files listed in `delete`, and launches
  `Dofus Retro.exe` or `resources/app/retroclient/Dofus.exe` per the `arch` setting — the same
  choice `zaap.yml` encodes.
- Manifest paths are resolved through `safeJoin`, which rejects anything escaping the install root.
- Server-side endpoints live in `StarLoco-Web/launcher/` (`status.php` → TCP probe + `COUNT(*)
  FROM world_accounts WHERE logged = 1`; `news.php` → `website_timeline_news`, the table the
  portal's admin page already writes).
- Deploy: `node tools/build-manifest.js --copy`, then rsync `dist-update/` to `<docroot>/launcher/`.
  See `launcher/README.md`.

**The shipped Electron runtime is 11.5.0 (Chrome 87)** — read from `Dofus Retro.exe`'s version
strings. `main.jsc` is bytenode V8 bytecode welded to that build, so the dev fallback
(`cd resources/app && npx electron .` with `main.jsc` renamed aside) only works on exactly
`electron@11.5.0`. `resources/app/package.json` is pinned accordingly.

**The legacy path is self-contained.** `retroclient/Dofus.exe` (`OriginalFilename: DofusWrapper`)
is a 32-bit Flash projector whose embedded SWF is byte-identical to `preloader.swf`; it loads
`loader.swf` + `config.xml` from its own directory. Same game, minus the Electron extras
(detachable chat, debug console, Discord RPC).

### Client SWF mods (`StarLoco-Client/`)
The Dofus 1.39 client is shipped as an Electron app wrapping a Flash runtime. The main script SWF lives at `StarLoco-Client/resources/app/retroclient/loader.swf`. Source is AS2 with heavy obfuscation (classes renamed to `_SafeStr_NNN`, members bracket-accessed with non-printable string keys like `this.api["\x1c\x16\n"]`).

**Editing workflow — use JPEXS Free Flash Decompiler, P-Code tab (not decompiled AS):**
1. Open `loader.swf` in JPEXS.
2. Navigate the script tree to the target class (e.g. `dofus._SafeStr_0.gapi.ui.StatsJob`).
3. Click the **P-Code** tab and edit instruction-by-instruction. Preserve labels that are jump targets (`locXXXX:`) — they're referenced by `If`/`Jump` offsets elsewhere in the function.
4. Click the in-pane **Save** to commit the P-Code change, then **File → Save** to write the SWF.

Why not edit the decompiled ActionScript: JPEXS' AS2 recompiler is sometimes lossy with obfuscated string-keyed member accesses and can break the runtime lookups. P-Code edits preserve the constant pool verbatim.

Stat-boost client/server contract (relevant when modding `StatsJob`): the client sends `AS<stat>` (single +1) or `AS<stat>|<quantity>` (multi). Both are handled in `StarLoco-Game/src/org/starloco/locos/game/GameClient.java#boost` (`Player.boostStat` / `Player.boostStatFixedCount`).

**Applied patch — StatsJob "always show quantity popup" (2026-05-21):**
In `dofus._SafeStr_0.gapi.ui.StatsJob`, function `click`, inside the `_btn10`–`_btn15` handler block, label `loc1277` originally held:
```
loc1277:Not
If loc13cc
```
This skipped the popup when no modifier key was held. Replace with:
```
loc1277:Pop
```
The `Pop` discards the boolean and falls through unconditionally to the popup construction, making every click open the quantity dialog. The label `loc1277` must be kept — it is a jump target from `loc1423` elsewhere in the function.

### Drop system (`StarLoco-Game/`)

The `drops` table columns: `objectId`, `monsterId`, `percentGrade1`–`percentGrade5`, `minObj`, `maxObj`, `condition`, `action`.

**`action` semantics:**
- `'-1'` — regular drop → loaded into `dropsPlayers` → per-winner RNG roll at end of fight
- `'1'` — meat drop → loaded into `dropsMeats` → only delivered if the winning player's equipped weapon has spell effect `795` (Chasseur / Hunter job trait); otherwise silently discarded

**Drop pipeline in `Fight.java`:**
- `4595–4628` — splits dead mob's drops into `dropsPlayers` (action != 1) and `dropsMeats` (action == 1)
- `4856–4976` — per-winner roll: `chance = localPercent × prospecting × conquestBonus × challengeFactor × starFactor × Config.rateDrop`
- `4978–4998` — meat path: delivers to inventory only if weapon effect 795 is equipped
- `5040–5092` — builds `dropsToAttribute`, then `TimerWaiter.addNext` gives items after 1 second

**`DropData.loadFully()` (`database/data/game/DropData.java`):** Clears all monster drops, then re-attaches from DB. Silently skips any row where `getObjTemplate(objectId) == null` OR `getMonstre(monsterId) == null`. Check server logs for "loaded successfully" to confirm.

**In-game admin command:** `.RELOAD DROPS` — reloads the drops table from DB into memory without a server restart.

**Meat items are NOT a single item type.** For example, `Chair de Larve` is type 63 but `Cervelle de larve` is type 69. Never use a single `item_template.type` value to distinguish meat from regular drops when writing SQL fixes.

**Diagnostic query:**
```sql
SELECT objectId, action FROM drops WHERE monsterId = <id>;
```
If all rows show `action = 1`, the drop clobber bug (see DB Migrations below) is active.

**Live DB repair (if migration 08 ran with bad data):**
```bash
# In StarLoco-Game directory:
sed -n '3474,8072p' db-init/04-game.sql > /tmp/10-update_game_drops_database_22.05.26.sql
# Then in mysql:
# USE starloco_game; TRUNCATE TABLE drops; SOURCE /tmp/10-update_game_drops_database_22.05.26.sql;
```
Then run `.RELOAD DROPS` in-game.

### DB migrations (`StarLoco-Game/db-init/`)

Docker init runs SQL files in numeric order: `04-game.sql` (full seed) → `05` → `06` → `07` → `08-update_game_08.05.23.sql`.

**Known fixed bug (2026-05-21):** `08-update_game_08.05.23.sql` originally DROPped and recreated the `drops` table with every row set to `action = '1'`, clobbering the correct values from `04-game.sql`. Symptom: players receive XP and kamas after fights but zero item drops. The file was rewritten — its first 78 lines (USE / sorts UPDATE / donjons) are preserved; the drops section was replaced with `04-game.sql:3474-8072` (DROP/CREATE + correct INSERTs with proper action values). Future `docker compose up` deploys will produce correct drops automatically.

## Key Configuration (`game.config.properties`)
```
system.server.exchange.ip / .port / .key  — game↔login channel
system.server.game.ip / .port / .id       — public game socket
database.login.*  /  database.game.*      — DB credentials
system.server.game.rate.*                 — XP/drop/kamas multipliers
system.server.game.mode.heroic            — heroic server mode
system.server.debug                       — enables debug log level
```
