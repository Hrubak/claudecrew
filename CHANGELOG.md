# Changelog

## Unreleased
- Setup and uninstall pass the install folder as `"%~dp0."` so a trailing backslash cannot break `--dir`. Node also strips stray quotes and trailing separators.
- Uninstall stops detected Crew processes in tree order (tray, then run-crew shells, then the node server and descendants), never by image name, and never stops the uninstall wizard itself. After removal it re-scans and can retry any that are still running.
- New backups write a `manifest.json` (version, date, source folders, file counts) and log how many files were written, skipped, or missing, including data/, summaries and workspaces. Setup and Settings can restore a backup, with zip-slip checks, secret skipping, and Merge / Replace / Cancel when files already exist.

- Prerequisites can install the official Claude CLI (`irm https://claude.ai/install.ps1 | iex`, from https://code.claude.com/docs/en/quickstart), Git, and Node.js LTS with live output and a re-check. Sign-in opens a visible terminal. Continue without signing in remains available.
- Uninstall now scans for every Crew install and leftover (processes, tray, shortcuts, scheduled tasks, Run keys, and known folders), with a checkbox list, a read-only `uninstall.cmd --scan --json` / `node scripts/crew-scan.js --json` mode, and a self-delete handoff when removing the running copy.

- Setup wizard (`setup.cmd`) replaces `INSTALL.bat` / `install.ps1`. Installs are always a git clone (never a ZIP). Default source is hast3/claudecrew `main`; Hrubak/claudecrew `crew-mods` is a preset. Optional autostart is off by default.
- Folder picker (Browse…) and path checks: block Downloads, temp, and ZIP extracts; warn if the folder is not empty; confirm it is writable.
- Settings > General: Switch source (never discards uncommitted work) and an Uninstall danger zone. `uninstall.cmd` backs up user data by default to a zip outside the install folder.
- `.gitignore` now also ignores `.env.*`, `secrets/`, and `install-manifest.json`.

- Settings dialog (header 🛠) to edit general options, usage guard and crew members without touching crew.config.json. Local-only; keeps a crew.config.json.bak.
- Restart button (header ↻) that waits for Crew to come back and reloads the page.
- Effort picker (low to max) per agent, default low for every model, plus a Routing section in Settings. The agent dialog shows "Last request: model · effort".
- Shared judge (`lib/judge.js`, `POST /api/judge`), OFF by default and only manual; nothing calls it automatically.

## 0.6.0
- Sidebar layout on desktop and a slide-out crew drawer on phones, with unread badges and a compact header menu.
- Integrations panel: linked MCP servers, services and secret-looking environment variable names (values are never read), and which agents can reach them.
- Layout preferences (order, groups, pins) sync through the server, so a refresh or another browser keeps them.
- Start a message with ! to make it urgent: it skips the concurrency cap and the budget hold.
- Stop-all button, friendlier activity labels, queued badge.
- Automatic fresh conversation when an agent's context gets heavy or a session runs long, carrying a short summary forward.
## 0.5.0
- Groups: put agents into named containers (agent dialog > Group, or drag a card onto another). Groups collapse and show a status summary. Saved per browser.
- Notes pad: each group has a 📝 checklist of open and done items, saved on the server in `data/notes.json` (new `/api/notes` endpoints).
- Crew bar: drag to reorder, pin, pick a colour, and set a custom emoji per agent. Added more colour themes.

## 0.4.0
- New `install.ps1`: one PowerShell command installs Node.js and Claude Code if missing, downloads Crew to `C:Crew`, creates the config, starts it, joins a hub and sets up autostart. Run it again to update.
- Machines: **Get pairing code** now also shows a ready-to-paste install line for a new PC (needs the hub reachable via Cloudflare or `allowLan`).
- Setup docs reorganised around "what do I run, and when".

## 0.3.1
- Machines: new "Connect this PC to a hub" box in the panel. Enter the hub address and the pairing code, no config editing or restart. Problems (expired code, unreachable hub, Cloudflare blocking) are explained in plain words.
- Remote pairing now recommends a single Cloudflare Bypass rule for `api/presence/*` instead of a service token (the token still works).
- New endpoints `/api/machines/link`, `/connect` and `/disconnect`.

## 0.3.0
- Machines: new panel (🖥) showing which computers run Crew and whether they are online. Other installs pair once with a short code and send a heartbeat every 30 s. Remote machines can reach the hub through Cloudflare Access with a service token. See docs/MACHINES.md.
- New settings `machineName` and `presenceHub`; new endpoints under `/api/machines` and `/api/presence`.

## 0.2.1
- The page header now shows the installed version (for example v0.2.1).

## 0.2.0
- Update check: Crew looks for a newer GitHub release at start and every 6 hours (quietly, if it can't reach GitHub). A button in the page header shows "Update available (vX)".
- One-click update from the PC Crew runs on. A git clone is fast-forwarded to the release; a zip install has the release files copied over it. `crew.config.json`, `data/`, `workspace/` and `.env` files are never touched.
- New endpoint `GET /api/update`.

## 0.1.0
- First public release.
