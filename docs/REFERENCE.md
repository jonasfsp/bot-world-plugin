[English README](../README.md) · [한국어 README](../README.ko.md) · **Full Reference**

# Bot World Technical Reference (`v1.0.0`)

Complete reference for plugin settings, keyboard shortcuts, Bot RPG mechanics, security architecture, verification commands, and release history.

---

## Complete Settings Reference

### Manifest Settings (`orca-plugin.json`)

| Key | Type | Values / Range | Default | Description |
| --- | --- | --- | --- | --- |
| `defaultTheme` | `string` | `startup_office`, `corporate_office`, `cozy_cafe`, `cyber_ops` | `startup_office` | Default office canvas theme (`Startup Office`, `Corporate Office`, `Cozy Cafe`, or `Cyber Ops`). |
| `redactMode` | `boolean` | `true` / `false` | `false` | Hide sensitive task titles, tool names, message bodies, and event summaries. |
| `pollIntervalSec` | `integer` | `2` – `60` | `5` | Default status polling interval in seconds. |
| `language` | `string` | `auto`, `en`, `ko` | `auto` | Display language (`auto` follows Orca UI locale). |
| `atmosphereMode` | `string` | `auto`, `day`, `sunset`, `night` | `auto` | Time-of-day lighting (`auto` follows live or replay timestamp; `day` 07:00–16:59, `sunset` 17:00–19:59, `night` 20:00–06:59). |
| `weatherMode` | `string` | `auto`, `clear`, `rain`, `snow`, `starlight` | `auto` | Ambient weather effect (`auto` matches active theme and time of day). |
| `viewMode` | `string` | `office`, `pet`, `broadcast` | `office` | Default visualization mode (`Isometric Office`, `Pocket Pet Terrarium`, or `Broadcast Chroma Bar`). |
| `allowQuickSend` | `boolean` | `true` / `false` | `false` | Opt-in: allow sending messages and 1-click `Needs You` decision replies to Orca bots from Bot World (disabled by default for read-only safety). |
| `desktopNotifications` | `boolean` | `true` / `false` | `false` | Opt-in: OS desktop alerts when a bot enters `Needs You`, `Error`, or `Stuck Watchdog` state (disabled by default; Redact-safe). |
| `stuckThresholdMin` | `integer` | `0` – `180` | `15` | Minutes without status, task, or tool change before flagging a `Working` bot or active sub-worker as stuck (`0` disables watchdog). |

### Workspace & UI Preferences

- **`soundMode`** (`off` | `chimes` | `ambient`, default `off`): Toggled via `M` or the toolbar button and persisted locally in `botWorld.prefs`. Only synthesizes Web Audio cues after an explicit user gesture.
- **`broadcastChroma`** (`green` | `blue` | `black` | `charcoal`, default `green`): Chroma-key backdrop color for the Broadcast Chroma Bar (`B`), kept in view session memory (not persisted).
- **`.botworld` Document Fields**: Custom board files store view preferences only (`themeId`, `atmosphereMode`, `weatherMode`, `redactMode`, `selectedBotId`, `botAppearances`, `customDeskPositions`, `zones`, `showZones`) and never persist sensitive task text.
- **24h Replay Timeline**: Automatically records sanitized snapshots into `botWorld.timeline` for 24h scrubbing (`1x`, `2x`, `5x`, `10x`) and 10-second Daily Timelapse playback.

---

## Complete Keyboard Shortcuts

All shortcuts work outside text inputs in both the Sidebar Panel and `.botworld` Office Board (`Space` applies to `.botworld` Replay; `WASD` / `Arrow` keys apply while Owner Avatar Roaming is active).

| Key | Action | Scope |
| --- | --- | --- |
| `T` | Cycle office theme (`Startup Office` → `Corporate Office` → `Cozy Cafe` → `Cyber Ops`) | Panel & `.botworld` |
| `A` | Cycle atmosphere (`Auto` → `Day` → `Sunset` → `Night`) | Panel & `.botworld` |
| `W` | Cycle weather (`Auto` → `Clear` → `Rain` → `Snow` → `Starlight`) | Panel & `.botworld` |
| `M` | Cycle sound mode (`Off` → `Chimes` → `Ambient`) | Panel & `.botworld` |
| `G` | Toggle visualization mode (`Office` ↔ `Pocket Pet Terrarium`) | Panel & `.botworld` |
| `B` | Toggle Broadcast Chroma-Key Pet Bar (`ON` / `OFF`) | Panel & `.botworld` |
| `U` | Open / close Creator Studio | Panel & `.botworld` |
| `V` | Toggle Owner Avatar Roaming (`ON` / `OFF`) | Panel & `.botworld` |
| `WASD` / `Arrow` / Double-click | Walk Owner Avatar across the office floor (when Roaming is `ON`) | Stage Canvas |
| `H` | High-Five nearby bot (`+8 XP`, 3s cooldown) | Panel & `.botworld` |
| `K` | Hand Coffee to nearby bot (`+10 XP`, 3s cooldown) | Panel & `.botworld` |
| `N` | Focus urgent (`Needs You` / `Error`) or active bot (Focus Spotlight) | Panel & `.botworld` |
| `F` | Toggle Follow Cam on selected bot | Panel & `.botworld` |
| `0` | Reset camera zoom & pan | Panel & `.botworld` |
| `/` | Focus bot search input | Panel & `.botworld` |
| `C` | Toggle 24h collaboration network overlay | Panel & `.botworld` |
| `Z` | Toggle `.botworld` Team Zones floor overlay | Panel & `.botworld` |
| `P` | Save 1-click PNG Photo Card snapshot | Panel & `.botworld` |
| `I` | Open / close 24h Office Digest Report | Panel & `.botworld` |
| `R` | Toggle Redact Mode (`ON` / `OFF`) | Panel & `.botworld` |
| `L` | Switch display language (`EN` / `한국어`) | Panel & `.botworld` |
| `D` | Toggle Demo Office (`ON` / `OFF`) | Panel & `.botworld` |
| `Space` | Play / pause 24h timeline replay | `.botworld` Editor |
| `Esc` | Close modal, release Follow Cam, clear search/filter, or clear selection | Panel & `.botworld` |
| `?` | Show / hide Keyboard Shortcuts modal | Panel & `.botworld` |

---

## Bot RPG & Owner Roaming Mechanics

### Level Progression & Titles

| Level | XP Floor | English Title | 한국어 칭호 |
| :---: | :---: | :--- | :--- |
| `Lv.1` | `0` | Intern | 인턴 |
| `Lv.2` | `40` | Junior | 주니어 |
| `Lv.3` | `100` | Engineer | 엔지니어 |
| `Lv.4` | `190` | Senior | 시니어 |
| `Lv.5` | `320` | Staff | 스태프 |
| `Lv.6+` | `500` (`+250` per level above Lv.6) | Archmage | 아크메이지 |

### XP Sources & Desk Props

- **Interactive Actions** (`RPG_ACTION_XP`, 3-second per-bot/action cooldown): `headpat` (`+5 XP`), `toy` (`+5 XP`), `high_five` (`+8 XP`), `coffee` (`+10 XP`).
- **Automated Work Events** (deduplicated per event ID): task/worker/automation completions (`+25 XP`), sub-worker starts & bot messages (`+10 XP`), working state ticks (`+5 XP`).
- **6 Unlockable Pixel Desk Props**: `🦆` Rubber Duck (`Lv.1`), `🪴` Mini Plant (`Lv.2`), `⌨️` Mech Keyboard (`Lv.3`), `🖥️` Dual Monitor (`Lv.4`), `🐱` Cat Plush (`Lv.5`), `🏆` Gold Trophy (`Lv.6`).

---

## Security & Permissions

Bot World is built as a **read-only-by-default**, zero-egress plugin with strict opt-in write and alert boundaries.

### Declared Capabilities (`orca-plugin.json`)

| Capability | Purpose & Strict Scope |
| --- | --- |
| `storage:own` | Persists `botWorld.prefs`, `botWorld.timeline`, `botWorld.weeklyTrend`, `botWorld.rpg.v1`, and `botWorld.creator.v1` locally inside plugin storage. |
| `settings:own` | Reads and reacts to user-configured plugin settings in Orca. |
| `agent:read` | Reads live bot, chat, worktree, orchestration, and automation snapshots. |
| `workspace:write` | Used exclusively for 1-click teleport (`terminal.focus` and `workspace.open`) on `↗ Terminal` / `↗ Workspace` clicks — never writes files or workspace config. |
| `notifications:show` | Used exclusively for opt-in OS notifications (`desktopNotifications: false` by default) when a bot enters `Needs You`, `Error`, or `Stuck Watchdog`. |

### Runtime & Storage Guards

- **Zero External Network (`connect-src 'none'`)**: Both `panel/index.html` and `editor/index.html` enforce `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`, and the `.botworld` editor runs with `"frame": "isolated"`.
- **XSS-Safe DOM**: Renders UI solely via `textContent` and `createTextNode` (`shared/dom.ts`), with zero `innerHTML` or `eval`.
- **CLI Subcommand Allowlist & Safe Spawn**: Read-only polling runs via `execFile(..., { shell: false })` with `TRUSTED_ORCA_PATHS`, symlink/ownership checks, `buildMinimalSafeEnv()`, and `assertAllowedSubcommand()` permitting only:
  - `status --json`
  - `bot list --json`, `bot chats --bot <name> --all --json`, `bot item list --bot <name> [--all] --json`
  - `worktree ps --since <dur> --json`
  - `orchestration inbox --limit <n> --full --json`, `orchestration worker-list --limit <n> [--cursor <c>] --full --json`, `orchestration run-list --full --json`
  - `automations list --json`, `automations runs --json`
- **Opt-In Quick Send, Decision Replies, Notifications & Watchdog**:
  - `allowQuickSend` (`false` by default): When enabled, `sendQuickBotMessage` (`buildQuickSendArgs`) and `botWorld.replyNeedsOwnerItem` (`buildItemReplyArgs` → `replyNeedsOwnerItem`) validate bot targets (and `needs_you` item ownership plus safe-integer item numbers for decision replies), reject control characters, enforce `1–500` character limits, apply a 2-second per-bot cooldown, scrub error strings with `scrubAll()`, and remain strictly separated from the read-only `assertAllowedSubcommand()` allowlist.
  - `desktopNotifications` (`false` by default): Skips initial sync bursts, applies a 60-second per-bot/kind cooldown for `Needs You` / `Error` and a 15-minute cooldown (`STUCK_NOTIFY_COOLDOWN_MS`) for `Stuck` alerts, truncates title/body lengths, and masks names/prompts/tasks/tools/errors with `scrubAll()` and **Redact Mode** aliases (`Bot #N` / `봇 #N`).
  - `StuckWatchdogTracker` (`stuckThresholdMin`, default `15`, `0` disables): Monitors `Working` bots and active sub-workers strictly in memory (capped at `MAX_TRACKED_WATCHDOG_ENTRIES = 256` per map), suppresses evaluation when disconnected/offline (`!snapshot.runtime.connected`) or during timeline replay, enforces the 15-minute notification cooldown (`STUCK_NOTIFY_COOLDOWN_MS`), and applies `scrubAll()` plus **Redact Mode** masking (`Bot #N` / `봇 #N`, hiding `lastTaskTitle` and `lastTool`).
- **PII-Free Local Schemas & Secret Scrubbing**:
  - `scrubAll()` masks AWS access keys, Slack/GitHub/Bearer/API tokens, webhook URLs, PEM private key blocks, email addresses, payment card numbers, and 12-digit AWS account IDs before storage or rendering.
  - `botWorld.weeklyTrend` stores daily integer rollups only (`date`, `events`, `tasksDone`, `workerRuns`, `collaborations`).
  - `botWorld.rpg.v1` stores numeric counters and `equippedProp` IDs only (capped at `MAX_RPG_PROFILES = 256`, zero task text or PII).
  - `botWorld.creator.v1` stores user-uploaded custom avatars and office backgrounds via canvas-reencoded raster PNG/JPEG only (raw uploads capped at `4 MiB`; SVG, HTML, and non-raster payloads blocked; avatars cropped/re-encoded to `128×128` or `96×96` PNG `<= 120 KiB` up to `24` entries; backgrounds scaled up to `1600×1000` JPEG `<= 450 KiB`; stored payload capped at `900 KiB`; `.botworld-pack.json` export/import capped at `1,200 KiB` with `slot-N` keys, path stripping, and `scrubAll()` on pack names for zero PII).
  - **Redact Mode (`R`)** masks bot names as `Bot #N` / `봇 #N` across Pet mode, Broadcast mode, Quick Send, sidebar quick pills, filters, hover HUD, 24h Digest & Markdown export, and OS desktop notifications, while scrubbing secrets (`scrubAll()`) on stage labels/detail headers and masking all task titles, tool badges, and Team Zones (`Zone #N` / `구역 #N`).

---

## Verification Commands

Run the official Orca plugin verification gates from the repository root:

```sh
orca plugin validate . --json
orca plugin check . --json
orca plugin test . --json
```

---

## Release History (`v0.1.0` → `v1.0.0`)

- **`v1.0.0`**: Zero-layout-shift fixed-size toolbar (2-row 440px panel · single-row 1280px editor) & performance engine (parallel CLI polling, unchanged-snapshot fingerprint IPC suppression, 12s inactive-UI backoff, `ResizeObserver`, `visibilitychange` pause, offscreen backdrop cache, `DPR <= 2`, 3-tier Pocket Pet throttling, JPEG backdrops); opt-in **Needs You 1-Click Decision Reply** (`buildItemReplyArgs` / `botWorld.replyNeedsOwnerItem`, `allowQuickSend` default `false`, instant in Demo); **Stuck Bot Watchdog** (`StuckWatchdogTracker`, `stuckThresholdMin` default `15`, desk `⏳` badge, detail banner, 15m-cooldown Redact-safe OS alerts); and 24h Digest (`I`) **Daily Standup Markdown Export**.
- **`v0.9.0`**: Creator Studio (`U`) for canvas-sanitized custom avatars, office backgrounds, and `.botworld-pack.json` sharing (`botWorld.creator.v1`); Broadcast Chroma-Key Pet Bar (`B`) with Green/Blue/Black/Charcoal keys & hover-reveal exit pill; universal native hover tooltips across every control; and Redact Mode (`R`) alias coverage across Pet/Broadcast/Quick Send/pills/filters/hover HUD/notifications.
- **`v0.8.0`**: Bot RPG XP/leveling (`Lv.1 Intern` → `Lv.6+ Archmage`) with 6 desk props, Owner Avatar Roaming (`V`, `H` High-Five, `K` Hand Coffee), idle watercooler banter, opt-in OS desktop notifications (`desktopNotifications`), and RPG growth in the 24h Digest.
- **`v0.7.0`**: Pocket Pet Terrarium mode (`G`) with headpats & toys (`☕`/`🎾`/`🍪`), 1-click Terminal/Workspace teleport (`↗ Terminal`/`↗ Workspace`), and opt-in Quick Send paper planes (`allowQuickSend`).
- **`v0.6.0`**: 1-click PNG Photo Card (`P`), 10-second Daily Timelapse, PII-free 7-Day Weekly Activity Trend, and `.botworld` Team Zones (`Z`).
- **`v0.5.0`**: Procedural Web Audio soundscape (`M`), ambient weather particles (`W`), and office micro-events (error beacons, completion milestones, huddle sparkles).
- **`v0.4.0`**: Smart Camera (`N`, `F`, `0`, zoom/pan), status filter chips & `/` search, 24h Collaboration Network overlay (`C`), and Daily MVP / Office Badges.
- **`v0.3.0`**: `Cozy Cafe` & `Cyber Ops` themes (`T`), drag-and-drop custom desk layouts, and 24h Daily Office Digest Report (`I`).
- **`v0.2.0`**: Living Office time-of-day atmosphere (`A`), curved paper-plane/envelope couriers, sub-worker door commutes, and keyboard shortcuts (`?`).
- **`v0.1.3`**: Read-only **Try Demo Office** onboarding mode (`D`) and animated showcase preview.
- **`v0.1.2`**: Generalized role-aware avatar matching and 15+ bot overflow seating grid.
- **`v0.1.1`**: Bilingual English / 한국어 UI (`L` and `language` setting).
- **`v0.1.0`**: Initial public release with Sidebar Panel, `.botworld` Office Board, Redact Mode (`R`), and 24h timeline replay.

---

## Bot groups (`1.0.0-autoseller.4`)

- The filter bar shows a group picker once Orca reports any bot group. **All groups** shows every bot; a group shows only its bots, their sub-workers and items, in the office, Pocket Pet and Broadcast views. The choice is saved (`botWorld.prefs.groupFilter`) and set with `botWorld.setGroupFilter { group }` (`''` = all).
- Groups come from `orca bot chats --bot <name> --all`: each `bot-group-member-*` chat is a seat in a group, and its title is the group name. Those chats no longer show up as a bot's task title.
- Bots on a paired Orca server (`bot list` → `server.on`) are polled with `--environment <server>` on `bot chats` and `bot item list`; the allowlist accepts that flag only there, validated like a bot name.
- Redact Mode shows `Group #N` instead of group names.

---

## Company brand & project board (`1.0.0-autoseller.5`)

A `.botworld` board can carry two optional sections, written by a bot or script outside the plugin (the plugin never calls a tracker and holds no credentials):

```json
{
  "brand": { "name": "Stacx", "logo": "data:image/png;base64,..." },
  "projectBoard": {
    "updatedAt": "2026-11-27T18:23:23Z",
    "source": "ClickUp · Engenharia",
    "projects": [{ "name": "[VoxOS]", "backlog": 20, "todo": 2, "inProgress": 2, "toTest": 15 }]
  }
}
```

- **Brand**: the logo plaque hangs above the boss desk (PNG/JPEG/WebP data URL up to 120 KiB; anything else falls back to the name).
- **Project board**: hangs under the Automation Board, showing up to 6 projects with a backlog bar and count, the total, and the source with its time. A snapshot older than 26 h is shown as out of date.
- Edits made outside the editor (for example `fabrica.py clickup board --botworld <file>`) merge into an open board; saving from the editor keeps both sections.
- Redact Mode shows `Project #N` and hides the logo.
