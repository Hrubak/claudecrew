'use strict';
// Uninstall helpers. Path guards, Crew-only process stop, backup, and cleanup
// of shortcuts / autostart created by the wizard or the legacy INSTALL.bat / install.ps1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { execFileP, readManifest, isInside, defaultInstallDir, normalizeInstallDir, MANIFEST_NAME } = require('./setup');
const backup = require('./backup');
const scanLib = require('./scan');

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
  const raw = normalizeInstallDir(String(installDir || '').trim()) || '';
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

async function createBackupZip(installDir, destZip, userData, { run = execP, platform = process.platform, mkdir = fs.mkdirSync, log = () => {}, now, ...hooks } = {}) {
  if (!destZip) throw new Error('Backup path is missing.');
  if (isInside(path.resolve(destZip), path.resolve(installDir))) {
    throw new Error('Backup zip must be written outside the install folder.');
  }
  const items = (userData || []).map((u) => ({
    ...u,
    installDir: u.installDir || installDir,
    path: u.path || path.join(installDir, u.rel),
  }));
  if (!items.length) return { ok: true, path: destZip, empty: true, counts: { files: 0, bytes: 0, skipped: 0, missing: 0 } };
  return backup.writeBackup({ userData: items, dest: destZip, now, log, mkdir, ...hooks });
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
      backup = await backupFn(preview.installDir, dest, preview.userData, { run, platform, log, ...fsHooks });
      actions.push({ action: 'backup', path: dest, counts: backup && backup.counts });
      if (backup && backup.counts) {
        log('Backup counts: ' + backup.counts.files + ' files, ' + backup.counts.bytes + ' bytes'
          + (backup.counts.skipped ? ', skipped ' + backup.counts.skipped : '')
          + (backup.counts.missing ? ', missing ' + backup.counts.missing : ''));
      }
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


const scan = require('./scan');

function defaultBackupPath({ env = process.env, homedir = os.homedir(), now = new Date() } = {}) {
  return path.join(env.USERPROFILE || env.HOME || homedir, 'ClaudeCrew-backup-' + formatStamp(now) + '.zip');
}

function previewScanUninstall(scanResult, {
  selectedIds,
  dataMode = 'backup',
  env = process.env,
  homedir = os.homedir(),
  now = new Date(),
  exists = fs.existsSync,
  readdir = (p, o) => fs.readdirSync(p, o),
  readFile = fs.readFileSync,
  realpathSync,
  lstat,
} = {}) {
  const selected = scan.selectedFromScan(scanResult, selectedIds);
  const folders = selected.filter((i) => i.type === 'folder');
  const willDelete = [];
  const userData = [];
  const unsafe = [];
  const skipped = [];
  for (const folder of folders) {
    let root;
    try {
      root = assertSafeInstallDir(folder.path, { env, homedir, realpathSync, exists, lstat });
    } catch (err) {
      skipped.push({ path: folder.path, reason: err.message });
      continue;
    }
    const data = userDataPaths(root, { exists, readFile }).map((u) => ({ ...u, installDir: root }));
    userData.push(...data);
    const prev = previewUninstall(root, { dataMode, exists, readdir, readFile, env, homedir, realpathSync, lstat, now });
    for (const d of prev.willDelete) {
      willDelete.push({ ...d, installDir: root });
    }
    unsafe.push(...prev.unsafe.map((u) => ({ ...u, installDir: root })));
  }
  const processSel = [];
  const seenPid = new Set();
  for (const it of selected) {
    if (it.type === 'process' || it.type === 'tray') {
      const pid = Number(it.pid);
      if (!pid || seenPid.has(pid)) continue;
      seenPid.add(pid);
      processSel.push(it);
      willDelete.push({
        rel: (it.kind === 'tray' || it.type === 'tray' ? 'tray' : 'process') + ': PID ' + pid + (it.name ? ' ' + it.name : ''),
        path: '',
        type: it.type,
        pid,
        name: it.name,
        safe: true,
        item: it,
      });
      continue;
    }
    if (it.type === 'folder') continue;
    willDelete.push({
      rel: it.type + ':' + (it.path || it.name || it.id),
      path: it.path || '',
      type: it.type,
      hive: it.hive,
      name: it.name,
      pid: it.pid,
      safe: !it.readOnly,
      reason: it.readOnly ? 'read-only (listed, not deleted unless you have rights)' : undefined,
      item: it,
    });
  }
  const backupPath = dataMode === 'backup' ? defaultBackupPath({ env, homedir, now }) : null;
  if (backupPath && folders.some((f) => {
    try { return isInside(backupPath, f.path) || path.resolve(backupPath) === path.resolve(f.path); } catch { return false; }
  })) {
    throw new Error('Backup path must be outside every selected install folder.');
  }
  return {
    dataMode,
    selected,
    folders: folders.map((f) => f.path),
    userData,
    willDelete,
    unsafe,
    skipped,
    backupPath,
    processes: processSel,
    artifacts: selected.filter((i) => !['folder', 'process', 'tray'].includes(i.type)),
  };
}

function needsHandoff(folders, {
  cwd = process.cwd(),
  scriptPath = process.argv[1],
  execPath = process.execPath,
} = {}) {
  const points = [cwd, scriptPath, execPath].filter(Boolean).map((p) => path.resolve(p));
  for (const dir of folders || []) {
    let root;
    try { root = path.resolve(dir); } catch { continue; }
    if (points.some((p) => p === root || isInside(p, root))) return true;
  }
  return false;
}

function copyUninstallerToTemp({
  sourceRoot,
  tmpdir = os.tmpdir(),
  mkdir = fs.mkdirSync,
  copyFile = fs.copyFileSync,
  exists = fs.existsSync,
} = {}) {
  const dest = fs.mkdtempSync(path.join(tmpdir, 'crew-uninstall-'));
  mkdir(path.join(dest, 'lib'), { recursive: true });
  mkdir(path.join(dest, 'scripts'), { recursive: true });
  const files = [
    'setup-wizard.js',
    'lib/setup.js',
    'lib/uninstall.js',
    'lib/scan.js',
    'lib/backup.js',
    'lib/zip.js',
    'scripts/crew-scan.js',
    'scan-inventory.ps1',
  ];
  const copied = [];
  for (const rel of files) {
    const from = path.join(sourceRoot, rel);
    if (!exists(from)) continue;
    const to = path.join(dest, rel);
    mkdir(path.dirname(to), { recursive: true });
    copyFile(from, to);
    copied.push(rel);
  }
  if (!copied.includes('setup-wizard.js') || !copied.includes('lib/uninstall.js')) {
    throw new Error('Could not copy the uninstaller to a temp folder.');
  }
  return { dir: dest, copied };
}

function procPidOf(proc) {
  return Number(proc && (proc.pid || proc.ProcessId) || 0);
}

function procParentOf(proc) {
  return Number(proc && (proc.parentPid || proc.ParentProcessId || proc.ppid) || 0);
}

function isWizardCommand(proc) {
  const cmd = String((proc && proc.commandLine) || '');
  if (/setup-wizard\.js/i.test(cmd) && /--uninstall/i.test(cmd)) return true;
  if (/(?:^|[\\/\s"])uninstall\.cmd\b/i.test(cmd) && /setup-wizard\.js/i.test(cmd) === false) {
    // a cmd.exe hosting uninstall.cmd (parent of the wizard)
    if (/uninstall\.cmd/i.test(cmd)) return true;
  }
  if (/uninstall\.cmd/i.test(cmd)) return true;
  return false;
}

function excludedUninstallPids(processes, {
  selfPid = process.pid,
  selfPpid = process.ppid,
} = {}) {
  const byPid = new Map();
  for (const p of processes || []) {
    const pid = procPidOf(p);
    if (pid) byPid.set(pid, p);
  }
  const excluded = new Set();
  const addChain = (start) => {
    let cur = Number(start) || 0;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      excluded.add(cur);
      const rec = byPid.get(cur);
      cur = rec ? procParentOf(rec) : 0;
    }
  };
  addChain(selfPid);
  addChain(selfPpid);
  for (const p of processes || []) {
    if (isWizardCommand(p)) addChain(procPidOf(p));
  }
  return excluded;
}

function stopRank(proc) {
  const kind = proc && proc.kind || '';
  const cmd = String((proc && proc.commandLine) || '');
  const name = String((proc && proc.name) || '').toLowerCase();
  if (kind === 'tray' || /crew-tray\.ps1/i.test(cmd)) return 0;
  if (kind === 'helper' || /run-crew\.cmd/i.test(cmd)) return 1;
  if ((/^(cmd|cmd\.exe|conhost|conhost\.exe)$/.test(name)) && !/crew-tray\.ps1/i.test(cmd) && !isWizardCommand(proc)) return 1;
  if (kind === 'server' || (/server\.js/i.test(cmd) && /node/.test(name))) return 2;
  return 3;
}

function descendantPids(seedPids, processes) {
  const seeds = new Set([...seedPids].map(Number).filter(Boolean));
  const kids = new Map();
  for (const p of processes || []) {
    const pp = procParentOf(p);
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(p);
  }
  const out = new Set();
  const stack = [...seeds];
  while (stack.length) {
    const pid = stack.pop();
    for (const child of kids.get(pid) || []) {
      const cid = procPidOf(child);
      if (!cid || seeds.has(cid) || out.has(cid)) continue;
      out.add(cid);
      stack.push(cid);
    }
  }
  return out;
}

function planProcessStops(processes, {
  selfPid = process.pid,
  selfPpid = process.ppid,
} = {}) {
  const excluded = excludedUninstallPids(processes, { selfPid, selfPpid });
  const candidates = (processes || []).filter((p) => {
    const pid = procPidOf(p);
    return pid && !excluded.has(pid);
  });
  const planned = [];
  const seen = new Set();
  const add = (proc, why) => {
    const pid = procPidOf(proc);
    if (!pid || seen.has(pid) || excluded.has(pid)) return;
    seen.add(pid);
    planned.push({ ...proc, pid, stopRank: why != null ? why : stopRank(proc) });
  };
  const sorted = [...candidates].sort((a, b) => stopRank(a) - stopRank(b) || procPidOf(a) - procPidOf(b));
  for (const p of sorted) add(p, stopRank(p));
  const desc = descendantPids(seen, processes);
  for (const p of processes || []) {
    if (desc.has(procPidOf(p))) add(p, 3);
  }
  planned.sort((a, b) => a.stopRank - b.stopRank || a.pid - b.pid);
  return { planned, excluded: [...excluded] };
}

function stillRunningFromScan(scanResult, { excludedPids, stoppedPids } = {}) {
  const skip = new Set([...(excludedPids || []), ...(stoppedPids || [])].map(Number));
  const items = [];
  const groups = (scanResult && scanResult.groups) || {};
  for (const list of [groups.processes || [], groups.tray || []]) {
    for (const it of list) {
      const pid = procPidOf(it);
      if (!pid || skip.has(pid)) continue;
      if (isWizardCommand(it)) continue;
      items.push(it);
    }
  }
  const seen = new Set();
  return items.filter((it) => { const p = procPidOf(it); if (seen.has(p)) return false; seen.add(p); return true; });
}

async function stopSelectedProcesses(processes, {
  dryRun = false,
  platform = process.platform,
  run = execP,
  selfPid = process.pid,
  selfPpid = process.ppid,
  ...fsHooks
} = {}) {
  const actions = [];
  const { planned, excluded } = planProcessStops(processes, { selfPid, selfPpid });
  for (const pid of excluded) {
    const match = (processes || []).find((p) => procPidOf(p) === Number(pid));
    if (match) actions.push({ action: 'exclude', pid: Number(pid), reason: 'uninstall wizard process or ancestor', kind: match.kind });
  }
  const seen = new Set();
  for (const proc of planned) {
    const pid = Number(proc.pid);
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    const cmd = proc.commandLine || '';
    const cmdline = await (async () => {
      try { return await commandLineForPid(pid, { platform, run, ...fsHooks }); } catch { return cmd; }
    })();
    const hay = String(cmdline || cmd || '');
    const stillCrew = /server\.js/i.test(hay) || /crew-tray\.ps1/i.test(hay) || /run-crew\.cmd/i.test(hay);
    // Do not treat setup-wizard.js alone as a stop target (the running uninstaller).
    if (!stillCrew && !dryRun) {
      actions.push({ action: 'skip-stop', pid, reason: 'PID no longer looks like a Crew process' });
      continue;
    }
    if (dryRun) {
      actions.push({ action: 'stop', pid, dryRun: true, kind: proc.kind, stopRank: proc.stopRank, via: 'tree' });
      continue;
    }
    const args = platform === 'win32' ? ['/PID', String(pid), '/T'] : ['-TERM', String(pid)];
    const file = platform === 'win32' ? 'taskkill' : 'kill';
    const r = await run(file, args);
    actions.push({
      action: 'stop',
      pid,
      ok: r.ok || r.code === 128 || r.code === 1,
      kind: proc.kind,
      stopRank: proc.stopRank,
      via: 'taskkill-pid',
    });
  }
  return actions;
}

async function removeSelectedArtifacts(artifacts, { dryRun = false, platform = process.platform, run = execP, unlink = fs.unlinkSync, exists = fs.existsSync } = {}) {
  const actions = [];
  for (const a of artifacts || []) {
    if (a.readOnly && a.hive === 'HKLM') {
      actions.push({ action: 'skip', type: a.type, name: a.name, reason: 'HKLM is read-only; not changed' });
      continue;
    }
    if (a.type === 'shortcut' || a.kind && String(a.kind).endsWith('Shortcut') || a.path && String(a.path).toLowerCase().endsWith('.lnk')) {
      const p = a.path;
      if (p && exists(p)) {
        actions.push({ action: 'remove-file', path: p, type: a.kind || 'shortcut' });
        if (!dryRun) try { unlink(p); } catch (err) { actions[actions.length - 1].error = err.message; }
      } else {
        actions.push({ action: 'missing', path: p, type: 'shortcut' });
      }
    } else if (a.type === 'scheduledTask') {
      actions.push({ action: 'remove-task', name: a.name || TASK_NAME });
      if (!dryRun && platform === 'win32') {
        await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          "Stop-ScheduledTask -TaskName '" + String(a.name || TASK_NAME).replace(/'/g, "''") + "' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '" + String(a.name || TASK_NAME).replace(/'/g, "''") + "' -Confirm:$false -ErrorAction SilentlyContinue"]);
      }
    } else if (a.type === 'runKey') {
      if (a.hive === 'HKLM') {
        actions.push({ action: 'skip', type: 'runKey', name: a.name, reason: 'HKLM is read-only; not changed' });
        continue;
      }
      actions.push({ action: 'remove-run-key', name: a.name, hive: a.hive || 'HKCU' });
      if (!dryRun && platform === 'win32') {
        const key = a.key || 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
        await run('powershell.exe', ['-NoProfile', '-Command',
          "Remove-ItemProperty -Path 'HKCU:\\" + key.replace(/'/g, "''") + "' -Name '" + String(a.name || 'Claude Crew').replace(/'/g, "''") + "' -ErrorAction SilentlyContinue"]);
      }
    }
  }
  return actions;
}

async function backupMany(userData, dest, { run = execP, mkdir = fs.mkdirSync, log = () => {}, now, ...hooks } = {}) {
  if (!userData || !userData.length) return { path: dest, skipped: true, counts: { files: 0, bytes: 0, skipped: 0, missing: 0 } };
  for (const it of userData) {
    const root = it.installDir;
    if (root && (isInside(dest, root) || path.resolve(dest) === path.resolve(root))) {
      throw new Error('Backup path must be outside every selected install folder.');
    }
  }
  return backup.writeBackup({ userData, dest, now, log, mkdir, ...hooks });
}

async function runScanUninstall({
  scanResult,
  selectedIds,
  dataMode = 'backup',
  dryRun = false,
  backupPath,
  log = () => {},
  platform = process.platform,
  run = execP,
  env = process.env,
  homedir = os.homedir(),
  sourceRoot,
  tmpdir,
  spawnFn,
  execPath = process.execPath,
  cwd,
  scriptPath,
  copyFile,
  mkdir,
  exists,
  selfPid = process.pid,
  selfPpid = process.ppid,
  rescan,
  ...fsHooks
} = {}) {
  const preview = previewScanUninstall(scanResult, { selectedIds, dataMode, env, homedir, ...fsHooks });
  if (preview.unsafe.length) {
    throw new Error('Refusing to delete: ' + preview.unsafe.map((u) => u.path + ' (' + u.reason + ')').join('; '));
  }
  const folders = preview.folders;
  if (!dryRun && needsHandoff(folders, { cwd: cwd || process.cwd(), scriptPath: scriptPath || process.argv[1], execPath })) {
    const copied = copyUninstallerToTemp({ sourceRoot, tmpdir, mkdir, copyFile, exists: exists || fs.existsSync });
    return { ok: true, handedOff: true, tempDir: copied.dir, copied: copied.copied, preview, dryRun: false };
  }
  const actions = [];
  let backup = null;
  if (dataMode === 'backup' && preview.userData.length) {
    const dest = backupPath || preview.backupPath;
    for (const f of folders) {
      if (isInside(dest, f) || path.resolve(dest) === path.resolve(f)) {
        throw new Error('Backup path must be outside the install folders.');
      }
    }
    log('Backing up user data to ' + dest);
    if (dryRun) {
      actions.push({ action: 'backup', path: dest, dryRun: true });
    } else {
      backup = await backupMany(preview.userData, dest, { platform, run, log, ...fsHooks });
      actions.push({ action: 'backup', path: dest, counts: backup && backup.counts });
    }
  }
  log('Stopping Crew processes (tray, then shells, then server, then descendants)');
  actions.push(...await stopSelectedProcesses(preview.processes, { dryRun, platform, run, selfPid, selfPpid, ...fsHooks }));
  actions.push(...await removeSelectedArtifacts(preview.artifacts, { dryRun, platform, run, ...fsHooks }));
  for (const folder of folders) {
    const subset = preview.willDelete.filter((d) => d.installDir === folder && (d.type == null || d.folder || d.rel));
    const entries = previewUninstall(folder, { dataMode, env, homedir, ...fsHooks }).willDelete;
    log('Deleting inside ' + folder);
    actions.push(...await deleteInside(folder, entries, { dryRun, ...fsHooks }));
  }
  let stillRunning = [];
  const exclude = excludedUninstallPids(preview.processes, { selfPid, selfPpid });
  const stopped = new Set(actions.filter((a) => a.action === 'stop' && a.ok !== false).map((a) => a.pid));
  try {
    const next = typeof rescan === 'function'
      ? await rescan()
      : (typeof fsHooks.rescan === 'function' ? await fsHooks.rescan() : (dryRun ? null : await scanLib.scanCrew({ currentDir: folders[0], extraDirs: folders, env, homedir })));
    if (next) stillRunning = stillRunningFromScan(next, { excludedPids: exclude, stoppedPids: dryRun ? [] : stopped });
  } catch { /* rescan is best-effort */ }
  if (backup && backup.counts) {
    log('Backup counts: ' + backup.counts.files + ' files, ' + backup.counts.bytes + ' bytes'
      + (backup.counts.skipped ? ', skipped ' + backup.counts.skipped : '')
      + (backup.counts.missing ? ', missing ' + backup.counts.missing : ''));
  }
  return { ok: true, dryRun, preview, backup, actions, handedOff: false, stillRunning, excludedPids: [...exclude] };
}

module.exports = {
  TASK_NAME, DESKTOP_SHORTCUT, STARTUP_SHORTCUT, PID_NAME, USER_DATA_ENTRIES,
  realpathSafe, assertSafeInstallDir, isSafeToDelete, userDataPaths, detectLegacyArtifacts,
  previewUninstall, formatStamp, readPidFile, isCrewNodeProcess, commandLineForPid,
  listeningPidOnPort, findCrewProcess, stopCrewProcess, createBackupZip,
  removeAutostartAndShortcuts, deleteInside, runUninstall,
  defaultBackupPath, previewScanUninstall, needsHandoff, copyUninstallerToTemp,
  stopSelectedProcesses, removeSelectedArtifacts, backupMany, runScanUninstall,
  planProcessStops, excludedUninstallPids, stillRunningFromScan, stopRank,
};
