**English** · [한국어](./README.ko.md) · [Full Reference](./docs/REFERENCE.md)

# Bot World for Orca

**Turn your Orca bots and live sub-workers into a living isometric office, Pocket Pet terrarium, Broadcast Chroma Bar, and local Bot RPG — read-only by default, with zero external network calls.**

![Version 1.0.0](https://img.shields.io/badge/version-1.0.0-2563eb) ![Orca >= 1.4.265](https://img.shields.io/badge/Orca-%3E%3D1.4.265-0f766e) ![License MIT](https://img.shields.io/badge/license-MIT-475569) ![Privacy First](https://img.shields.io/badge/privacy--first-zero%20external%20network-16a34a)

![Bot World live preview](assets/showcase/preview.gif)

*Virtual Office, Pocket Pet Terrarium (`G`), Broadcast Chroma Bar (`B`), Creator Studio (`U`), Bot RPG (`V`/`H`/`K`), Quick Send & Decision Reply, Stuck Watchdog, and 24h Digest (`I`) — all running locally inside Orca.*

## Fork note: cross-platform CLI discovery

This is a local fork of upstream v1.0.0 (`1.0.0-autoseller.x`) with one change: `src/orca-cli.ts` now finds the Orca CLI on Windows and Linux too, not only on macOS.

- Discovery order: `ORCA_CLI_COMMAND` (an absolute path to an existing file), then the platform defaults. Windows: `%LOCALAPPDATA%\Programs\Orca\resources\bin\orca.exe`, then `%ProgramFiles%\Orca\resources\bin\orca.exe`. Linux: `${XDG_CONFIG_HOME:-~/.config}/orca/cli/bin/orca`, then `/opt/Orca/resources/bin/orca-ide`. macOS: the same paths as upstream.
- The POSIX owner/mode/ancestor checks are unchanged. On Windows they are replaced by: a drive-absolute path, a `.exe` file (a `.cmd` path is mapped to the sibling `orca.exe`, never run, because of CVE-2024-27980), an existing regular file, and a realpath inside `%LOCALAPPDATA%` or `%ProgramFiles%` (or equal to `ORCA_CLI_COMMAND`).
- Orca forks plugin workers with a reduced env (no `LOCALAPPDATA`/`APPDATA`/`ProgramFiles`/`ORCA_CLI_COMMAND`), so on Windows the CLI is also derived from the running Orca (`dirname(process.execPath)\resources\bin\orca.exe`) and from the profile (`%USERPROFILE%\AppData\Local\Programs\Orca\…`), and `APPDATA`/`LOCALAPPDATA` are derived from the profile for the CLI when missing (`1.0.0-autoseller.2`).
- When discovery or a CLI run fails, one short line per error code per minute goes to the plugin log (`orca plugin logs`): platform, env key presence (never values), `process.execPath`, each candidate with its rejection reason, and the spawn error code.
- Windows CLI limits: 20 s default timeout (30 s cap) and at most 2 concurrent CLI calls, because each call cold-starts Orca.exe (a cold `orchestration worker-list` measured 11.4 s). Every failed CLI call is logged with its command (`args[0..1]`) and duration. Only a failed or unreachable `status`, or a runtime-level error, turns the board Offline; an isolated failure of another command keeps that command's previous data (`1.0.0-autoseller.3`).
- The command allowlist, argument validation and Quick Send opt-in are unchanged.

## Quick Start

1. **Install** from the Orca catalog or load locally:
   ```sh
   orca plugin install ddochi-nyang/bot-world-plugin
   ```
   ```sh
   git clone https://github.com/ddochi-nyang/bot-world-plugin.git && cd bot-world-plugin && orca plugin dev load .
   ```
2. **Open a view**: Click **Bot World** in the Orca status bar (Sidebar Panel) or create **New File → New Bot World Board (`.botworld`)** for the full-screen 2-column stage and 24h timeline.
3. **Preview instantly**: Click **Try Demo Office** on an empty workspace (or **Demo** in the toolbar) to test live animations, RPG props, Pocket Pet toys, Broadcast Chroma Bar, and Creator Studio with zero CLI writes.

## Highlights

- **Living Virtual Office**
  - 4 themes (`Startup Office`, `Corporate Office`, `Cozy Cafe`, `Cyber Ops`) with `Auto`/`Day`/`Sunset`/`Night` lighting (`A`) and `Rain`/`Snow`/`Starlight` weather (`W`).
  - Zero-asset procedural Web Audio soundscape (`M`, off by default), drag-and-drop custom seating, and translucent `.botworld` Team Zones (`Z`).
- **Pocket Pet & Quick Send**
  - Switch to Pocket Pet Terrarium (`G`) in either the sidebar or `.botworld` board — pet bots for heart reactions or toss **☕ Coffee / 🎾 Ball / 🍪 Treat** toys.
  - Opt-in **Quick Send** paper planes from the Owner Desk (`allowQuickSend`, default `false`) plus 1-click **↗ Terminal** and **↗ Workspace** teleport.
- **Creator Studio & Broadcast Bar**
  - Open **Creator Studio** (`U`) to drag-and-drop custom bot avatars and office backgrounds (canvas-sanitized raster PNG/JPEG, SVG/HTML blocked) and share portable `.botworld-pack.json` asset packs.
  - Switch to the OBS/streaming **Broadcast Chroma-Key Pet Bar** (`B`) with Green/Blue/Black/Charcoal chroma keys, hover-reveal exit pill, and universal native hover tooltips across every control.
- **Bot RPG & Owner Roaming**
  - Privacy-safe local XP & leveling (`Lv.1 Intern` → `Lv.6+ Archmage`) unlocks 6 pixel desk props (`🦆`, `🪴`, `⌨️`, `🖥️`, `🐱`, `🏆`) displayed right on each bot's desk.
  - Toggle **Owner Avatar Roaming** (`V`), walk with `WASD` / Arrow keys / canvas double-click, press `H` for **High-Five** (`+8 XP`) or `K` for **Hand Coffee** (`+10 XP`), and enjoy idle watercooler banter.
- **Zero-Layout-Shift Toolbar & Performance Engine**
  - Fixed-height, fixed-width toolbar (2-row 440px panel · single-row 1280px editor with `0px` shift on click) and lightweight JPEG office backdrops.
  - Parallel CLI polling with unchanged-snapshot fingerprint IPC suppression and 12s inactive-UI backoff, plus `ResizeObserver`, `visibilitychange` pause, offscreen background cache, `DPR <= 2` cap, and 3-tier Pocket Pet throttling.
- **Command & Ops Controls**
  - Opt-in **Needs You 1-Click Decision Reply** (`allowQuickSend` default `false`, instant in Demo) and **Stuck Bot Watchdog** (`stuckThresholdMin` default `15`m: desk `⏳` badge, detail banner, and 15m-cooldown Redact-safe OS alerts).
  - One-click **Daily Standup Markdown Export** inside the 24h Office Digest (`I`).
- **Replay, Digest & Privacy-First Design**
  - Scrub 24h snapshots, play a **10s Daily Timelapse**, inspect the **24h Office Digest** (`I`) with Daily MVP, Bot Growth, and **7-Day Weekly Trend**, or save a **PNG Photo Card** (`P`).
  - Read-only by default, one-click **Redact Mode** (`R`), strict `connect-src 'none'` CSP with zero external network, and opt-in guards for Quick Send and OS Desktop Notifications.

## Showcase

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="assets/showcase/office-rpg-roam.jpg" alt="Bot World Owner Avatar Roaming, High-Five proximity HUD, and RPG desk props" />
      <br /><strong>Owner Roaming &amp; RPG Desk Props</strong><br />
      <sub>Walk the floor (<code>V</code>), trigger proximity <code>H</code> High-Five / <code>K</code> Coffee, and unlock desk props.</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="assets/showcase/pet-terrarium.jpg" alt="Bot World Pocket Pet Terrarium mode with interactive toys and live animations" />
      <br /><strong>Pocket Pet Terrarium Mode</strong><br />
      <sub>Glass-knocking <code>Needs You</code> pets, headpats, and ☕/🎾/🍪 toys (<code>G</code>).</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="assets/showcase/broadcast-chroma.jpg" alt="Bot World Broadcast Chroma-Key Pet Bar with Green chroma background and hover-reveal toolbar" />
      <br /><strong>Broadcast Chroma-Key Pet Bar</strong><br />
      <sub>OBS-ready Green/Blue/Black/Charcoal chroma bar with hover-reveal exit pill (<code>B</code>).</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="assets/showcase/creator-studio.jpg" alt="Bot World Creator Studio modal for custom avatars, backgrounds, and .botworld-pack.json export" />
      <br /><strong>Creator Studio &amp; Asset Packs</strong><br />
      <sub>Drag-and-drop canvas-sanitized avatars &amp; backgrounds and export <code>.botworld-pack.json</code> (<code>U</code>).</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="assets/showcase/office-quicksend.jpg" alt="Bot World opt-in Quick Send bar launching a golden paper-plane courier" />
      <br /><strong>Opt-In Quick Send Paper Planes</strong><br />
      <sub>Golden paper-plane dispatch from the Owner Desk (opt-in in Live Mode, active in Demo).</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="assets/showcase/office-report.jpg" alt="Bot World 24h Office Digest modal with Bot Growth and Levels and 7-Day Weekly Trend" />
      <br /><strong>24h Office Digest, Bot Growth &amp; 7-Day Trend</strong><br />
      <sub>KPIs, Daily MVP badges, Bot Growth &amp; Levels, hourly chart, and Markdown export (<code>I</code>).</sub>
    </td>
  </tr>
</table>

<details>
<summary>More screenshots (10 additional views)</summary>

| View | Preview | View | Preview |
| :--- | :---: | :--- | :---: |
| **Startup Office** | ![Startup Office](assets/showcase/startup-office.jpg) | **Corporate Office** | ![Corporate Office](assets/showcase/corporate-office.jpg) |
| **Cyber Ops** | ![Cyber Ops](assets/showcase/cyber-ops.jpg) | **Night Atmosphere** | ![Night Office](assets/showcase/night-office.jpg) |
| **Cozy Cafe + Rain (`W`)** | ![Cozy Cafe Rain](assets/showcase/cozy-rain.jpg) | **RPG Level & Desk Props** | ![RPG Detail Props](assets/showcase/rpg-detail-props.jpg) |
| **Team Zones (`Z`)** | ![Team Zones](assets/showcase/team-zones.jpg) | **Redact & 24h Replay (`R`)** | ![Redact & Replay](assets/showcase/redact-replay.jpg) |
| **Collab Network (`C`)** | ![Collab Network](assets/showcase/command-collab.jpg) | **Compact Sidebar Panel** | ![Compact Sidebar Panel](assets/showcase/sidebar-panel.jpg) |

</details>

## Essential Shortcuts

| Key | Action | Key | Action |
| :---: | :--- | :---: | :--- |
| `G` | Toggle Office ↔ Pocket Pet | `B` | Toggle Broadcast Chroma-Key Pet Bar |
| `U` | Open / close Creator Studio | `M` | Cycle sound (`Off` / `Chimes` / `Ambient`) |
| `V` | Toggle Owner Avatar Roaming (`WASD`/Arrows) | `I` | Open / close 24h Office Digest |
| `H` / `K` | High-Five / Hand Coffee to nearby bot | `P` | Save 1-click PNG Photo Card |
| `T` | Cycle 4 office themes | `R` | Toggle Redact Mode (`ON` / `OFF`) |
| `W` | Cycle weather (`Auto` / `Clear` / `Rain` / `Snow` / `Starlight`) | `?` | Open all keyboard shortcuts |

See [Full Shortcuts, Settings & Security Reference](./docs/REFERENCE.md) for all 20+ shortcuts, `.botworld` options, and RPG tables.

## Security & Privacy Summary

- **Read-Only & Opt-In Writes**: CLI polling uses a strict `assertAllowedSubcommand()` allowlist (`execFile`, `shell: false`). Both `allowQuickSend` (Quick Send & 1-click `Needs You` replies) and `desktopNotifications` (`Needs You` / `Error` / `Stuck Watchdog`) default to `false`, and `workspace:write` is used solely for 1-click `terminal.focus` / `workspace.open` teleport.
- **Zero External Network**: Isolated custom editor frame (`frame: "isolated"`) with `connect-src 'none'`; all audio, particles, PNG photo cards, Creator Studio re-encoding, and XP storage run 100% locally.
- **PII Scrubbing & Redact Mode**: Secrets, tokens, emails, cards, and 12-digit AWS account IDs are masked before storage or rendering; `botWorld.weeklyTrend`, `botWorld.rpg.v1`, and `botWorld.creator.v1` enforce strict schemas with zero PII.
- **XSS-Safe DOM**: Built exclusively with `textContent` and `createTextNode` (zero `innerHTML` or `eval`).

Full details: [Security & Permissions Reference](./docs/REFERENCE.md#security--permissions).

---

Licensed under the [MIT License](./LICENSE).
