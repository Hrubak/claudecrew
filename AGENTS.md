# Claude Crew — agent guide

Claude Crew is a local Windows-first app that runs a small crew of Claude agents together: a web UI, a Node server, and optional tray autostart. Coding agents working in this repo should read this file first.

## Repo layout

- `server.js` — the Crew server (default port 7777).
- `setup.cmd` / `setup-wizard.js` — install, repair, switch-source, and restore wizard (binds to 127.0.0.1 only).
- `uninstall.cmd` — uninstall wizard; also supports a read-only scan (`uninstall.cmd --scan --json`).
- `lib/` — shared server, setup, uninstall, scan, and backup helpers.
- `scripts/` — CLI helpers, including the read-only `scripts/crew-scan.js`.
- `*.ps1` — Windows helpers (folder/backup pickers, tray, inventory scan, bootstrap). Call them as scripts with argv, never by concatenating a shell string.
- `test/` — Node’s built-in test runner.

## Run

```
node server.js
```

Crew listens on port 7777 by default (`http://localhost:7777`). `run-crew.cmd` is the usual Windows launcher.

## Test

```
node --test test/*.test.js
```

Add tests for new logic. Keep existing path-guard, process, backup, and prereq tests passing.

## Install, uninstall, and restore

Installs are always a git clone (never a ZIP). Default source is `hast3/claudecrew` `main`; `Hrubak/claudecrew` `crew-mods` is a preset. `setup.cmd` checks prerequisites, can install the official Claude CLI / Git / Node, and can restore `data/`, `crew.config.json`, summaries, and workspaces from a `ClaudeCrew-backup-*.zip` before Options. Settings > General can import a backup into the current install.

Uninstall scans for leftover Crew folders, processes, shortcuts, and autostart, backs up user data by default (outside the install folder), and stops processes in tree order. After removal it re-scans and can retry anything still running.

## Conventions

- Windows-first. Prefer PowerShell helpers and argv arrays; do not interpolate user input into a shell command.
- Stop Crew processes by exact PID only (`taskkill /PID <pid> /T` or `Stop-Process` by PID). Never kill by image name (`taskkill /IM`, `Stop-Process -Name`).
- Do not stop the setup or uninstall wizard’s own process (or its ancestors) mid-run.
- Keep `install-manifest.json` and backup zip formats backward compatible (legacy zips may have no manifest; infer their layout). New backups should keep writing a manifest and file counts.
- User PATH changes belong on the User PATH only, never the Machine PATH, and never with `setx`.

## Rules

- Never commit secrets, `.env`, `.env.*`, or `secrets/`. Do not read or restore those when handling backups.
- No force-push.
- Work on the `crew-mods` branch of `Hrubak/claudecrew`.
- `hast3/claudecrew` is upstream with unrelated history. Do not open PRs against it or push to it unless the owner asks.
- Push only after the owner approves. Local commits are fine when asked.
- Do not invoke the real Claude CLI unless the owner explicitly wants that in this session (tests should stub it).
