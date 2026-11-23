# Changelog

## Unreleased

### 2026-11-23 — Safer uninstall and a single hidden run-crew loop

- `run-crew.cmd` no longer uses `timeout` (which popped a visible console). Before each start it checks whether Crew is already answering on its port and exits instead of starting a second copy. A launcher lock allows only one `run-crew.cmd` loop per install. Repeated quick crashes back off 10s, 30s, 60s, up to five minutes. The scheduled task starts it with `conhost.exe --headless`; the wait uses in-process `ping -n`.
- Uninstall backs up first and verifies the zip (it opens, manifest counts match, and it is not empty when `data/` has files). A failed backup aborts the uninstall. It then writes a stop flag so `run-crew.cmd` exits instead of restarting, stops run-crew loops before tray and servers (exact PID only), re-scans and retries up to three times, and only then removes files (`data/` last, then the empty install folder). If processes are still running after three tries, files are not removed.
- The uninstaller locates the live install (from `install-manifest.json`, the scheduled task, or running run-crew/server command lines) and shows it for confirmation. It will not delete the folder it was started from unless that folder is the install.

### 2026-11-23 — User PATH fix and agent guides

- After installing the official Claude CLI, and on every prerequisite check, the wizard adds `%USERPROFILE%\.local\bin` to the User PATH (never the Machine PATH, never with `setx`) if `claude.exe` is there but the folder is missing. The current process PATH is updated so Sign in and `claude --version` work before a new terminal is opened. A status line reports the change; if the write fails, manual steps and a Fix PATH button are shown.
- Add AGENTS.md (and a short CLAUDE.md that points to it) so coding agents know how to work in this repo.

### 2026-11-23 — Restore from backup, process stop, and `--dir` fix

- Setup and uninstall pass the install folder as `"%~dp0."` so a trailing backslash cannot break `--dir`. Node also strips stray quotes and trailing separators.
- Uninstall stops detected Crew processes in tree order (tray, then run-crew shells, then the node server and descendants), never by image name, and never stops the uninstall wizard itself. After removal it re-scans and can retry any that are still running.
- New backups write a `manifest.json` (version, date, source folders, file counts) and log how many files were written, skipped, or missing, including data/, summaries and workspaces. Setup and Settings can restore a backup, with zip-slip checks, secret skipping, and Merge / Replace / Cancel when files already exist.

### 2026-11-23 — Official prereq installers and universal scan uninstall

- Prerequisites can install the official Claude CLI (`irm https://claude.ai/install.ps1 | iex`, from https://code.claude.com/docs/en/quickstart), Git, and Node.js LTS with live output and a re-check. Sign-in opens a visible terminal. Continue without signing in remains available.
- Uninstall now scans for every Crew install and leftover (processes, tray, shortcuts, scheduled tasks, Run keys, and known folders), with a checkbox list, a read-only `uninstall.cmd --scan --json` / `node scripts/crew-scan.js --json` mode, and a self-delete handoff when removing the running copy.

### 2026-11-21 — Setup wizard, uninstall, and Switch source

- Setup wizard (`setup.cmd`) replaces `INSTALL.bat` / `install.ps1`. Installs are always a git clone (never a ZIP). Default source is hast3/claudecrew `main`; Hrubak/claudecrew `crew-mods` is a preset. Optional autostart is off by default.
- Folder picker (Browse…) and path checks: block Downloads, temp, and ZIP extracts; warn if the folder is not empty; confirm it is writable.
- Settings > General: Switch source (never discards uncommitted work) and an Uninstall danger zone. `uninstall.cmd` backs up user data by default to a zip outside the install folder.
- `.gitignore` now also ignores `.env.*`, `secrets/`, and `install-manifest.json`.

### 2026-11-20 — Settings, effort, and judge

- Settings dialog (header 🛠) to edit general options, usage guard and crew members without touching crew.config.json. Local-only; keeps a crew.config.json.bak.
- Restart button (header ↻) that waits for Crew to come back and reloads the page.
- Effort picker (low to max) per agent, default low for every model, plus a Routing section in Settings. The agent dialog shows "Last request: model · effort".
- Shared judge (`lib/judge.js`, `POST /api/judge`), OFF by default and only manual; nothing calls it automatically.
- Wider nav without h-scroll; context windows as a dropdown (200k / 1M / Custom).

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
