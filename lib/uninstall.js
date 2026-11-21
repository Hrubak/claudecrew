'use strict';
// Uninstall helpers. Path guards, Crew-only process stop, backup, and cleanup
// of shortcuts / autostart created by the wizard or the legacy INSTALL.bat / install.ps1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { execFileP, readManifest, isInside, defaultInstallDir, MANIFEST_NAME } = require('./setup');

const TASK_NAME = 'Claude Crew';
const DESKTOP_SHORTCUT = 'Claude Crew.lnk';
const STARTUP_SHORTCUT = 'Claude Crew tray.lnk';
const PID_NAME = path.join('data', 'crew.pid');
const USER_DATA_ENTRIES = ['data', 'crew.config.json', 'workspace', 'install-log.txt'];

function execP(cmd, args, opts = {}) { return execFileP(cmd, args, opts); }

function realpathSafe(p, { realpathSync = (x) => fs.realpathSync(x), exists = fs.existsSync } = {}) {
  const abs = path.resolve(p);
  try { return exists(abs) ? realpathSync(abs) : abs; } catch { return abs; }
}

// Refuse to treat a path as an install folder we may delete from.
function assertSafeInstallDir(installDir, {
  homedir = os.homedir(),
  env = process.env,
  platform = process.platform,
  realpathSync = (x) => fs.realpathSync(x),
  exists = fs.existsSync,
  lstat = (p) => fs.lstatSync(p),
} = {}) {
  const raw = String(installDir || '').trim();
  if (!raw) throw new Error('Install folder path is empty. Uninstall will not continue.');
  const resolved = path.resolve(raw);
  const root = path.parse(resolved).root;
  if (!resolved || resolved === root || resolved === path.sep || /^[A-Za-z]:\\?$/.test(resolved)) {
    throw new Error('Refusing to uninstall from the drive root (' + resolved + ').');
  }
  const home = realpathSafe(env.USERPROFILE || env.HOME || homedir, { realpathSync, exists });
  if (path.resolve(resolved) === path.resolve(home) || realpathSafe(resolved, { realpathSync, exists }) === home) {
    throw new Error('Refusing to uninstall from the user profile root (' + home + ').');
  }
  if (exists(resolved)) {
    const st = lstat(resolved);
    if (st.isSymbolicLink && st.isSymbolicLink()) {
      const real = realpathSafe(resolved, { realpathSync, exists });
      // A junction/symlink install dir is only allowed if we operate on the real path
      // and still pass the root/home checks. Re-check the real path.
      if (real === path.parse(real).root || real === home) {
        throw new Error('Refusing to follow a symlink or junction that escapes to ' + real + '.');
      }
      return path.resolve(real);
    }
  }
  return resolved;
}

// A target may be deleted only if it resolves inside the install folder (no junction escape).
function isSafeToDelete(target, installDir, {
  realpathSync = (x) => fs.realpathSync(x),
  exists = fs.existsSync,
  lstat = (p) => fs.lstatSync(p),
} = {}) {
  const root = path.resolve(installDir);
  const abs = path.resolve(target);
  if (!isInside(abs, root) && abs !== root) return { ok: false, reason: 'outside-install' };
  if (!exists(abs)) return { ok: true, missing: true, path: abs };
  try {
    const realRoot = realpathSafe(root, { realpathSync, exists });
    const realTarget = realpathSafe(abs, { realpathSync, exists });
    if (realTarget !== realRoot && !isInside(realTarget, realRoot)) {
      return { ok: false, reason: 'symlink-escape', path: abs, real: realTarget };
    }
    // If this entry itself is a symlink/junction, only delete the link, never the external target.
    const st = lstat(abs);
    if (st.isSymbolicLink && st.isSymbolicLink()) {
      const dest = realpathSafe(abs, { realpathSync, exists });
      if (dest !== realRoot && !isInside(dest, realRoot)) {
        return { ok: false, reason: 'symlink-escape', path: abs, real: dest, deleteLinkOnly: false };
      }
    }
  } catch (err) {
    return { ok: false, reason: err.message, path: abs };
  }
  return { ok: true, path: abs };
}

function userDataPaths(installDir, { exists = fs.existsSync, readFile = fs.readFileSync } = {}) {
  const items = [];
  for (const rel of USER_DATA_ENTRIES) {
    const p = path.join(installDir, rel);
    if (exists(p)) items.push({ rel, path: p });
  }
  // summaries live under data/summaries in current Crew; still list a top-level summaries/ if present.
  const summaries = path.join(installDir, 'summaries');
  if (exists(summaries) && !items.some((i) => i.rel === 'summaries')) items.push({ rel: 'summaries', path: summaries });
  // Agent workspaces: only those whose cwd is inside the install folder.
  const cfgFile = path.join(installDir, 'crew.config.json');
  if (exists(cfgFile)) {
    try {
      const cfg = JSON.parse(readFile(cfgFile, 'utf8'));
      for (const a of cfg.agents || []) {
        if (!a.cwd) continue;
        const cwd = path.resolve(installDir, a.cwd);
        if (isInside(cwd, installDir) && exists(cwd) && !items.some((i) => i.path === cwd)) {
          items.push({ rel: path.relative(installDir, cwd) || a.cwd, path: cwd, agent: a.id || a.name });
        }
      }
    } catch { /* ignore bad config */ }
  }
  return items;
}

function detectLegacyArtifacts({
  env = process.env,
  homedir = os.homedir(),
  desktopDir,
  startupDir,
  exists = fs.existsSync,
  platform = process.platform,
} = {}) {
  const home = env.USERPROFILE || env.HOME || homedir;
  const desktop = desktopDir || path.join(home, 'Desktop');
  const startup = startupDir || path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const found = [];
  const desk = path.join(desktop, DESKTOP_SHORTCUT);
  const start = path.join(startup, STARTUP_SHORTCUT);
  if (exists(desk)) found.push({ type: 'desktopShortcut', path: desk, name: DESKTOP_SHORTCUT, source: 'legacy-or-manifest' });
  if (exists(start)) found.push({ type: 'startupShortcut', path: start, name: STARTUP_SHORTCUT, source: 'legacy-or-manifest' });
  // Task and Run key are Windows-only. Preview lists them as "if present";
  // uninstall still attempts to remove them on Windows even if preview missed them.
  if (platform === 'win32') {
    found.push({ type: 'scheduledTask', name: TASK_NAME, source: 'legacy-detection', detect: true });
    found.push({ type: 'runKey', name: 'Claude Crew', source: 'legacy-detection', detect: true });
  }
  return found;
}

function previewUninstall(installDir, {
  dataMode = 'backup',
  exists = fs.existsSync,
  readdir = (p, o) => fs.readdirSync(p, o),
  readFile = fs.readFileSync,
  env = process.env,
  homedir = os.homedir(),
  realpathSync,
  lstat,
  now = new Date(),
  platform = process.platform,
} = {}) {
  const root = assertSafeInstallDir(installDir, { env, homedir, realpathSync, exists, lstat });
  const manifest = readManifest(root, { readFile, exists });
  const userData = userDataPaths(root, { exists, readFile });
  const artifacts = [];
  if (manifest && Array.isArray(manifest.created)) {
    for (const item of manifest.created) {
      if (item.type === 'desktopShortcut' || item.type === 'startupShortcut' || item.type === 'scheduledTask' || item.type === 'runKey') {
        artifacts.push({ ...item, source: 'manifest' });
      }
    }
  }
  const detected = detectLegacyArtifacts({ env, homedir, exists, platform });
  for (const d of detected) {
    if (!artifacts.some((a) => (a.path && d.path && a.path === d.path) || (a.type === d.type && a.name === d.name))) {
      artifacts.push(d);
    }
  }

  const appDeletes = [];
  const dataDeletes = [];
  if (exists(root)) {
    let names = [];
    try { names = readdir(root); } catch { names = []; }
    const keep = new Set();
    if (dataMode === 'keep') userData.forEach((u) => keep.add(u.rel.split(/[\\/]/)[0]));
    for (const name of names) {
      const abs = path.join(root, name);
      const safety = isSafeToDelete(abs, root, { realpathSync, exists, lstat });
      const rec = { rel: name, path: abs, safe: safety.ok, reason: safety.reason };
      if (keep.has(name) || userData.some((u) => u.rel === name || u.rel.startsWith(name + path.sep) || u.rel.startsWith(name + '/'))) {
        if (dataMode === 'keep') continue;
        dataDeletes.push(rec);
      } else {
        appDeletes.push(rec);
      }
    }
    if (dataMode !== 'keep') {
      // The install folder itself is removed only when no user data is being kept.
      appDeletes.push({ rel: '.', path: root, safe: true, folder: true });
    }
  }

  const stamp = formatStamp(now);
  const backupDefault = path.join(env.USERPROFILE || env.HOME || homedir, 'ClaudeCrew-backup-' + stamp + '.zip');
  const unsafe = [...appDeletes, ...dataDeletes].filter((d) => d.safe === false);

  return {
    installDir: root,
    dataMode,
    manifest: !!manifest,
    legacy: !!(manifest && manifest.source === 'legacy') || exists(path.join(root, 'INSTALL.bat')) || exists(path.join(root, 'install.ps1')),
    userData,
    artifacts,
    appDeletes,
    dataDeletes: dataMode === 'keep' ? [] : dataDeletes,
    willDelete: dataMode === 'keep' ? appDeletes : [...appDeletes, ...dataDeletes],
    willKeep: dataMode === 'keep' ? userData : [],
    backupPath: dataMode === 'backup' ? backupDefault : null,
    unsafe,
    pidFile: path.join(root, PID_NAME),
  };
}

function formatStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function readPidFile(installDir, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  const file = path.join(installDir, PID_NAME);
  if (!exists(file)) return null;
  try {
    const raw = readFile(file, 'utf8').trim();
    if (/^\d+$/.test(raw)) return { pid: Number(raw), port: null, root: installDir };
    return JSON.parse(raw);
  } catch { return null; }
}

function parseLinuxCmdline(buf) {
  return String(buf || '').replace(/\0/g, ' ').trim();
}

function isCrewNodeProcess(cmdline, installDir) {
  const line = String(cmdline || '').toLowerCase();
  if (!line) return false;
  if (!/\bnode(\.exe)?\b/.test(line) && !/\\node\.exe\b/.test(line) && !/\/node\b/.test(line)) return false;
  if (!/server\.js\b/.test(line)) return false;
  const root = path.resolve(installDir).replace(/\\/g, '/').toLowerCase();
  const norm = line.replace(/\\/g, '/');
  return !root || norm.includes(root) || /(?:^|[\s"])server\.js(?:\s|"|$)/.test(line);
}

async function commandLineForPid(pid, { platform = process.platform, run = execP, readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  if (!pid || !Number.isFinite(Number(pid))) return '';
  if (platform !== 'win32') {
    const proc = '/proc/' + pid + '/cmdline';
    if (exists(proc)) {
      try { return parseLinuxCmdline(readFile(proc)); } catch { return ''; }
    }
    const r = await run('ps', ['-p', String(pid), '-o', 'args=']);
    return r.ok ? r.stdout : '';
  }
  const r = await run('powershell.exe', [
    '-NoProfile', '-Command',
    'Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '" | Select-Object -ExpandProperty CommandLine',
  ]);
  // Note: the PID is coerced to a number before interpolation, so this is not a shell-injection of a user path.
  return r.ok ? r.stdout : '';
}

async function listeningPidOnPort(port, { platform = process.platform, run = execP } = {}) {
  const n = Number(port);
  if (!n || n < 1) return null;
  if (platform !== 'win32') {
    const r = await run('sh', ['-c', 'fuser -n tcp ' + n + ' 2>/dev/null || ss -ltnp 2>/dev/null | grep -E \":' + n + '\\b\" || true']);
    // Port is numeric. Prefer lsof when present.
    const lsof = await run('lsof', ['-iTCP:' + n, '-sTCP:LISTEN', '-t']);
    if (lsof.ok && /^\d+$/m.test(lsof.stdout)) return Number(lsof.stdout.split(/\s+/)[0]);
    const m = (r.stdout || '').match(/\b(\d+)\b/);
    return m ? Number(m[1]) : null;
  }
  const r = await run('powershell.exe', [
    '-NoProfile', '-Command',
    '(Get-NetTCPConnection -LocalPort ' + n + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess',
  ]);
  const pid = Number(String(r.stdout || '').trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function findCrewProcess({
  installDir,
  port,
  pidFile,
  platform = process.platform,
  run = execP,
  readFile = fs.readFileSync,
  exists = fs.existsSync,
  listeningPid = listeningPidOnPort,
  cmdForPid = commandLineForPid,
} = {}) {
  const candidates = [];
  const fromFile = pidFile || readPidFile(installDir, { readFile, exists });
  if (fromFile && fromFile.pid) candidates.push({ pid: Number(fromFile.pid), via: 'pid-file', port: fromFile.port || port });
  if (port) {
    const p = await listeningPid({ port, platform, run });
    if (p) candidates.push({ pid: p, via: 'port', port });
  }
  const seen = new Set();
  for (const c of candidates) {
    if (!c.pid || seen.has(c.pid)) continue;
    seen.add(c.pid);
    const cmd = await cmdForPid(c.pid, { platform, run, readFile, exists });
    if (isCrewNodeProcess(cmd, installDir)) return { pid: c.pid, via: c.via, cmdline: cmd, port: c.port || port };
  }
  return null;
}

async function stopCrewProcess({ pid, installDir, dryRun = false, platform = process.platform, run = execP, killFn, cmdForPid = commandLineForPid, readFile, exists } = {}) {
  if (!pid) return { ok: true, skipped: true, reason: 'not-running' };
  const cmd = await cmdForPid(pid, { platform, run, readFile, exists });
  if (!isCrewNodeProcess(cmd, installDir)) {
    return { ok: false, error: 'PID ' + pid + ' is not Crew\'s node process. Uninstall will not stop it.', cmdline: cmd };
  }
  if (dryRun) return { ok: true, dryRun: true, action: 'stop', pid, cmdline: cmd };
  if (killFn) {
    await killFn(pid);
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch (err) {
      if (err && err.code !== 'ESRCH') return { ok: false, error: err.message, pid };
    }
  }
  return { ok: true, pid, cmdline: cmd };
}

async function createBackupZip(installDir, destZip, userData, { run = execP, platform = process.platform, mkdir = fs.mkdirSync } = {}) {
  if (!destZip) throw new Error('Backup path is missing.');
  if (isInside(path.resolve(destZip), path.resolve(installDir))) {
    throw new Error('Backup zip must be written outside the install folder.');
  }
  mkdir(path.dirname(destZip), { recursive: true });
  const rels = userData.map((u) => u.rel).filter((rel, i, a) => a.indexOf(rel) === i);
  if (!rels.length) return { ok: true, path: destZip, empty: true };
  const py = await run('python3', ['-c',
    'import zipfile, os, sys\n'
    + 'root, dest = sys.argv[1], sys.argv[2]\n'
    + 'rels = sys.argv[3:]\n'
    + 'with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:\n'
    + '    for rel in rels:\n'
    + '        src = os.path.join(root, rel)\n'
    + '        if not os.path.exists(src): continue\n'
    + '        if os.path.isdir(src):\n'
    + '            for dirpath, dirnames, filenames in os.walk(src):\n'
    + '                for fn in filenames:\n'
    + '                    full = os.path.join(dirpath, fn)\n'
    + '                    z.write(full, os.path.relpath(full, root))\n'
    + '        else:\n'
    + '            z.write(src, rel)\n',
    installDir, destZip, ...rels], { timeout: 120000 });
  if (py.ok) return { ok: true, path: destZip };
  const tar = await run('tar', ['-a', '-cf', destZip, '-C', installDir, ...rels], { timeout: 120000 });
  if (tar.ok) return { ok: true, path: destZip };
  throw new Error(py.stderr || tar.stderr || 'Could not create the backup zip.');
}

async function removeAutostartAndShortcuts(artifacts, { dryRun = false, platform = process.platform, run = execP, unlink = fs.unlinkSync, exists = fs.existsSync } = {}) {
  const actions = [];
  const list = [...artifacts];
  if (platform === 'win32') {
    if (!list.some((a) => a.type === 'scheduledTask')) list.push({ type: 'scheduledTask', name: TASK_NAME, detect: true });
    if (!list.some((a) => a.type === 'runKey')) list.push({ type: 'runKey', name: 'Claude Crew', detect: true });
  }
  for (const a of list) {
    if (a.type === 'desktopShortcut' || a.type === 'startupShortcut') {
      const p = a.path;
      if (p && exists(p)) {
        actions.push({ action: 'remove-file', path: p, type: a.type });
        if (!dryRun) try { unlink(p); } catch (err) { actions[actions.length - 1].error = err.message; }
      }
    } else if (a.type === 'scheduledTask') {
      actions.push({ action: 'remove-task', name: a.name || TASK_NAME });
      if (!dryRun && platform === 'win32') {
        await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          'Stop-ScheduledTask -TaskName \'' + TASK_NAME + '\' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName \'' + TASK_NAME + '\' -Confirm:$false -ErrorAction SilentlyContinue']);
      }
    } else if (a.type === 'runKey') {
      actions.push({ action: 'remove-run-key', name: a.name || 'Claude Crew' });
      if (!dryRun && platform === 'win32') {
        await run('powershell.exe', ['-NoProfile', '-Command',
          'Remove-ItemProperty -Path HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run -Name \'Claude Crew\' -ErrorAction SilentlyContinue']);
      }
    }
  }
  return actions;
}

async function deleteInside(installDir, entries, {
  dryRun = false,
  rm = (p, o) => fs.rmSync(p, o),
  unlink = fs.unlinkSync,
  rmdir = (p) => fs.rmdirSync(p),
  lstat = (p) => fs.lstatSync(p),
  exists = fs.existsSync,
  realpathSync,
} = {}) {
  const actions = [];
  const root = assertSafeInstallDir(installDir, { realpathSync, exists, lstat });
  const ordered = [...entries].sort((a, b) => String(b.path).length - String(a.path).length);
  for (const e of ordered) {
    const safety = isSafeToDelete(e.path, root, { realpathSync, exists, lstat });
    if (!safety.ok) {
      actions.push({ action: 'skip', path: e.path, reason: safety.reason });
      continue;
    }
    if (safety.missing) {
      actions.push({ action: 'missing', path: e.path });
      continue;
    }
    actions.push({ action: 'delete', path: e.path, rel: e.rel });
    if (dryRun) continue;
    try {
      const st = lstat(e.path);
      if (st.isSymbolicLink && st.isSymbolicLink()) unlink(e.path);
      else if (st.isDirectory()) rm(e.path, { recursive: true, force: true });
      else unlink(e.path);
    } catch (err) {
      actions[actions.length - 1].error = err.message;
    }
  }
  if (!dryRun && exists(root) && entries.some((e) => path.resolve(e.path) === root)) {
    try { rmdir(root); } catch { /* not empty if keep */ }
  }
  return actions;
}

async function runUninstall({
  installDir,
  dataMode = 'backup',
  dryRun = false,
  backupPath,
  env = process.env,
  homedir = os.homedir(),
  now = new Date(),
  run = execP,
  platform = process.platform,
  findProcess = findCrewProcess,
  stopProcess = stopCrewProcess,
  backupFn = createBackupZip,
  log = () => {},
  ...fsHooks
} = {}) {
  const preview = previewUninstall(installDir, { dataMode, env, homedir, now, ...fsHooks });
  if (preview.unsafe.length) {
    throw new Error('Refusing to delete paths that escape the install folder: ' + preview.unsafe.map((u) => u.path).join(', '));
  }
  const actions = [];
  let backup = null;
  if (dataMode === 'backup' && preview.userData.length) {
    const dest = backupPath || preview.backupPath;
    log('Backing up user data to ' + dest);
    if (dryRun) {
      backup = { ok: true, dryRun: true, path: dest };
      actions.push({ action: 'backup', path: dest, dryRun: true });
    } else {
      backup = await backupFn(preview.installDir, dest, preview.userData, { run, platform });
      actions.push({ action: 'backup', path: dest });
    }
  }
  const port = (() => {
    try {
      const cfg = JSON.parse((fsHooks.readFile || fs.readFileSync)(path.join(preview.installDir, 'crew.config.json'), 'utf8'));
      return cfg.settings && cfg.settings.port;
    } catch { return 7777; }
  })();
  const proc = await findProcess({ installDir: preview.installDir, port, platform, run, ...fsHooks });
  if (proc) {
    log('Stopping Crew process PID ' + proc.pid + ' (' + proc.via + ')');
    const stopped = await stopProcess({ pid: proc.pid, installDir: preview.installDir, dryRun, platform, run, ...fsHooks });
    actions.push({ action: 'stop', ...stopped });
    if (!stopped.ok) throw new Error(stopped.error || 'Could not stop Crew.');
  } else {
    actions.push({ action: 'stop', skipped: true, reason: 'not-running' });
  }
  const cleaned = await removeAutostartAndShortcuts(preview.artifacts, { dryRun, platform, run, ...fsHooks });
  actions.push(...cleaned);
  const toDelete = preview.willDelete;
  const deleted = await deleteInside(preview.installDir, toDelete, { dryRun, ...fsHooks });
  actions.push(...deleted);
  return { ok: true, dryRun, preview, backup, actions, process: proc };
}

module.exports = {
  TASK_NAME, DESKTOP_SHORTCUT, STARTUP_SHORTCUT, PID_NAME, USER_DATA_ENTRIES,
  realpathSafe, assertSafeInstallDir, isSafeToDelete, userDataPaths, detectLegacyArtifacts,
  previewUninstall, formatStamp, readPidFile, isCrewNodeProcess, commandLineForPid,
  listeningPidOnPort, findCrewProcess, stopCrewProcess, createBackupZip,
  removeAutostartAndShortcuts, deleteInside, runUninstall,
};
