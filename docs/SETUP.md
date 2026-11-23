# Setting up Claude Crew (Windows)

This takes about 10 minutes. You do not need administrator rights.

**What you need first:** a paid Claude account (Pro or Max). Free accounts do not work. Get one at https://claude.ai. You also need **git**, because Crew is always installed as a git clone (never a ZIP).

## The steps

1. **Get the wizard.** In a terminal: `git clone --branch main https://github.com/hast3/claudecrew.git` then open the new folder. (To use Jonathan’s fork instead, clone `https://github.com/Hrubak/claudecrew.git` and check out `crew-mods`.)
2. **Start the wizard.** Double-click **setup.cmd**. If Windows shows a blue box saying "Windows protected your PC", click **More info**, then **Run anyway**. A page opens in your browser at `http://127.0.0.1:17777`.
3. **Prerequisites.** The wizard checks Node.js 20+, git, and the Claude CLI. Each item has a fix-it link. If you are not signed in to Claude yet, you can open the sign-in page, or continue without signing in (agents will not work until you do).
4. **Choose a source.** Default is `hast3/claudecrew` on `main`. `Hrubak/claudecrew` (`crew-mods`) is a preset, or enter any git URL and branch (validated with `git ls-remote`).
5. **Install folder.** The path is prefilled with `%USERPROFILE%\ClaudeCrew`. Type a different path or click **Browse…** (a Windows folder picker). Downloads, temp folders and ZIP extracts are blocked. You will get a warning if the folder is not empty. The folder must be writable.
6. **Options.** Your name, port, LAN access, default model, default effort (**low**), permission mode (with a safety warning), and optional autostart (**off** by default).
7. **Finish.** The wizard clones the repo, writes `crew.config.json` if it does not already exist, and opens Crew. Next time, use the **Claude Crew** icon on your Desktop.

If this folder already has Crew, `setup.cmd` offers **Repair**, **Switch source**, or **Uninstall**.

## Uninstall

The wizard and Settings scan for every Crew install and leftover (processes, tray, shortcuts, scheduled tasks, Run/RunOnce keys, and known folders). Items outside your user profile are unchecked. A read-only listing that changes nothing:

```
uninstall.cmd --scan --json
```

or, from the Crew folder: `node scripts/crew-scan.js --json`.


Double-click **uninstall.cmd**, or open **Settings → General → Uninstall Claude Crew**. Choose **Back up** (the default), **Keep**, or **Delete** for your data. A backup zip is written outside the install folder, for example `%USERPROFILE%\ClaudeCrew-backup-YYYYMMDD-HHMMSS.zip`. You will see the exact list of what will be deleted, and must type `UNINSTALL` to confirm.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Windows protected your PC" | Click **More info**, then **Run anyway**. |
| "Node.js is still missing" | Go to https://nodejs.org, click the big **LTS** button, run it, accept the defaults, then run setup.cmd again. On a work laptop, ask IT to allow it. |
| "Git is still missing" | Go to https://git-scm.com/download/win, run it, accept the defaults, then run setup.cmd again. |
| The folder picker is not available | Type the path yourself. Browse… is Windows-only. |
| "Claude Code is not answering" | You need a paid Claude plan (Pro or Max). Open PowerShell, type `claude`, press Enter and follow the sign-in. |
| The page does not open | Open your browser and go to http://127.0.0.1:17777. After install, Crew is at http://localhost:7777. |
| Anything else | Send the file **install-log.txt** (in the Crew folder) to whoever is helping you. |

## Changing things later

- **Switch source or uninstall:** Settings > General, or run setup.cmd / uninstall.cmd again.
- **Add more helpers (agents):** Settings > Crew members, or edit `crew.config.json`.
- **Mac or Linux, or doing it by hand:** see [SETUP-ADVANCED.md](SETUP-ADVANCED.md).
- **Several PCs on one crew:** see [MACHINES.md](MACHINES.md).
