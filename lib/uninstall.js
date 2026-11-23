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
  backupFn,
  log = () => {},
  launcherDir,
  alreadyVerifiedBackup = false,
  rescan,
  maxStopTries = 3,
  selfPid = process.pid,
  selfPpid = process.ppid,
  processes,
  cwd,
  scriptPath,
  execPath,
  sourceRoot,
  tmpdir,
  ...fsHooks
} = {}) {
  const preview = previewUninstall(installDir, { dataMode, env, homedir, now, ...fsHooks });
  if (preview.unsafe.length) {
    throw new Error('Refusing to delete paths that escape the install folder: ' + preview.unsafe.map((u) => u.path).join(', '));
  }
  const port = (() => {
    try {
      const cfg = JSON.parse((fsHooks.readFile || fs.readFileSync)(path.join(preview.installDir, 'crew.config.json'), 'utf8'));
      return cfg.settings && cfg.settings.port;
    } catch { return 7777; }
  })();
  let procList = processes;
  let proc = null;
  if (!procList) {
    proc = await findProcess({ installDir: preview.installDir, port, platform, run, ...fsHooks });
    procList = proc ? [{ pid: proc.pid, kind: 'server', commandLine: proc.cmdline, name: 'node.exe', via: proc.via }] : [];
  }
  const wrappedBackup = backupFn
    ? async (userData, dest, hooks) => backupFn(preview.installDir, dest, userData, hooks)
    : undefined;
  const steps = await executeUninstallSteps({
    folders: [preview.installDir],
    preview,
    dataMode,
    dryRun,
    backupPath,
    alreadyVerifiedBackup,
    launcherDir: launcherDir || null,
    processes: procList,
    artifacts: preview.artifacts,
    userData: preview.userData.map((u) => ({ ...u, installDir: preview.installDir })),
    rescan,
    maxStopTries,
    selfPid,
    selfPpid,
    log,
    platform,
    run,
    env,
    homedir,
    backupFn: wrappedBackup,
    cwd,
    scriptPath,
    execPath,
    sourceRoot,
    tmpdir,
    ...fsHooks,
  });
  if (!proc && steps.actions.some((a) => a.action === 'stop' && a.skipped && a.reason === 'not-running') === false && !procList.length) {
    steps.actions.push({ action: 'stop', skipped: true, reason: 'not-running' });
  }
  if (steps.handedOff) return { ...steps, dryRun, preview, process: proc };
  return { ok: steps.ok !== false, dryRun, preview, backup: steps.backup, actions: steps.actions, process: proc, stillRunning: steps.stillRunning || [], handedOff: false, incomplete: steps.incomplete, reason: steps.reason };
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
    'lib/launcher-lock.js',
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
  // Loops first so they cannot respawn the server, then tray, then servers, then leftovers.
  if (kind === 'helper' || /run-crew\.cmd/i.test(cmd)) return 0;
  if ((/^(cmd|cmd\.exe|conhost|conhost\.exe)$/.test(name)) && !/crew-tray\.ps1/i.test(cmd) && !isWizardCommand(proc)) return 0;
  if (kind === 'tray' || /crew-tray\.ps1/i.test(cmd)) return 1;
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

function sameDir(a, b) {
  if (!a || !b) return false;
  try {
    return path.resolve(a).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      === path.resolve(b).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  } catch { return false; }
}

function looksLikeExtractOrSource(dir) {
  const root = path.resolve(dir || '');
  const base = path.basename(root);
  if (/-(main|master|crew-mods)$/i.test(base) || /^claudecrew-.*-(main|master|crew-mods)$/i.test(base)) return true;
  if (/[\\/]Mods[\\/]/i.test(root) && /claudecrew/i.test(base)) return true;
  return false;
}

function dirHasDataFiles(dir, { exists = fs.existsSync, readdir = (p, o) => fs.readdirSync(p, o), stat } = {}) {
  const data = path.join(dir, 'data');
  if (!exists(data)) return 0;
  try {
    return backup.dataFilesInUserData([{ rel: 'data', path: data, installDir: dir }], { exists, readdir, stat }).length;
  } catch {
    return 1;
  }
}

function stopFlagPaths(installDir) {
  const root = path.resolve(installDir);
  return [path.join(root, 'crew.stop'), path.join(root, 'data', 'crew.stop')];
}

function hasStopFlag(installDir, { exists = fs.existsSync } = {}) {
  return stopFlagPaths(installDir).some((p) => exists(p));
}

function writeStopFlag(installDir, {
  writeFile = fs.writeFileSync,
  exists = fs.existsSync,
  now = new Date(),
} = {}) {
  const root = path.resolve(installDir);
  const body = 'Crew uninstall requested at ' + now.toISOString() + '\nDo not restart. This file is safe to delete if you want to start Crew again.\n';
  const written = [];
  const rootFlag = path.join(root, 'crew.stop');
  writeFile(rootFlag, body, 'utf8');
  written.push(rootFlag);
  if (exists(path.join(root, 'data'))) {
    const dataFlag = path.join(root, 'data', 'crew.stop');
    writeFile(dataFlag, body, 'utf8');
    written.push(dataFlag);
  }
  return written;
}

function isDataOrUserRel(rel) {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!r || r === '.') return false;
  const top = r.split('/')[0];
  return USER_DATA_ENTRIES.includes(top) || top === 'summaries' || top === 'crew.stop';
}

function partitionDeletes(entries) {
  const app = [];
  const data = [];
  const roots = [];
  for (const e of entries || []) {
    if (e.rel === '.' || e.folder) roots.push(e);
    else if (isDataOrUserRel(e.rel)) data.push(e);
    else app.push(e);
  }
  return { app, data, roots };
}

function isConfirmedInstall(folder, { launcherDir, recommended } = {}) {
  if (!launcherDir || !sameDir(folder, launcherDir)) return true;
  const rec = recommended && (recommended.path || recommended);
  if (rec && sameDir(folder, rec)) return true;
  if (!rec) return true;
  return false;
}

function mayDeleteFolder(folder, { launcherDir, recommended, cwd, scriptPath, execPath } = {}) {
  if (!folder) return { ok: false, reason: 'empty' };
  const root = path.resolve(folder);
  if (!isConfirmedInstall(root, { launcherDir, recommended })) {
    return { ok: false, reason: 'uninstaller-home', path: root };
  }
  const points = [cwd, scriptPath, execPath].filter(Boolean).map((p) => path.resolve(p));
  if (points.some((p) => p === root || isInside(p, root))) {
    return { ok: false, reason: 'running-from', path: root };
  }
  return { ok: true, path: root };
}

function addLocateCandidate(map, dir, source, hooks) {
  if (!dir) return;
  let root;
  try { root = path.resolve(dir); } catch { return; }
  const exists = hooks.exists || fs.existsSync;
  if (exists(root) && hooks.stat) {
    try { if (hooks.stat(root).isFile()) root = path.dirname(root); } catch { /* keep */ }
  }
  const key = root.replace(/\\/g, '/').toLowerCase();
  let rec = map.get(key);
  if (!rec) {
    const verdict = scan.isCrewFolder(root, hooks);
    const manifest = readManifest(root, hooks);
    rec = {
      path: root,
      sources: [],
      markers: (verdict && verdict.markers) || [],
      isCrew: !!(verdict && verdict.ok),
      extract: looksLikeExtractOrSource(root),
      dataFiles: dirHasDataFiles(root, hooks),
      manifestDir: manifest && manifest.installDir || null,
      score: 0,
      live: false,
    };
    map.set(key, rec);
  }
  if (source && !rec.sources.includes(source)) rec.sources.push(source);
}

function scoreLocateCandidate(rec, { launcherDir, wellKnown } = {}) {
  let s = 0;
  if (rec.sources.includes('process') || rec.sources.includes('run-crew') || rec.sources.includes('scheduled-task')) s += 40;
  if (rec.dataFiles) s += 30;
  if (rec.manifestDir && sameDir(rec.manifestDir, rec.path)) s += 20;
  if (rec.isCrew) s += 10;
  if (wellKnown && wellKnown.some((p) => sameDir(p, rec.path))) s += 15;
  if (rec.extract) s -= 50;
  if (launcherDir && sameDir(rec.path, launcherDir) && rec.extract) s -= 20;
  rec.score = s;
  rec.live = s >= 20 || rec.dataFiles > 0
    || rec.sources.includes('process') || rec.sources.includes('run-crew') || rec.sources.includes('scheduled-task');
  return rec;
}

function locateInstalls({
  currentDir,
  extraDirs = [],
  scanResult,
  taskActions,
  processCommandLines,
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  exists = fs.existsSync,
  readFile = fs.readFileSync,
  readdir = (p, o) => fs.readdirSync(p, o),
  stat,
} = {}) {
  const hooks = { exists, readFile, readdir, stat };
  const map = new Map();
  const add = (dir, source) => addLocateCandidate(map, dir, source, hooks);
  if (currentDir) add(currentDir, 'current-dir');
  for (const d of extraDirs) add(d, 'extra');
  const wellKnown = scan.wellKnownFolders({ env, homedir, platform, exists, readdir, extra: [] });
  const knownInstalls = wellKnown.filter((p) => /ClaudeCrew$/i.test(p) || /(?:^|[\\/])Crew$/i.test(p));
  for (const d of knownInstalls) add(d, 'well-known');
  const manifestSeeds = [currentDir, ...extraDirs, ...knownInstalls].filter(Boolean);
  for (const d of manifestSeeds) {
    const m = readManifest(d, hooks);
    if (m && m.installDir) add(m.installDir, 'install-manifest');
  }
  const cmds = [...(processCommandLines || [])];
  if (scanResult && scanResult.groups) {
    for (const p of [...(scanResult.groups.processes || []), ...(scanResult.groups.tray || [])]) {
      if (p.commandLine) cmds.push(p.commandLine);
      if (p.executablePath) cmds.push(p.executablePath);
    }
  }
  for (const cmd of cmds) {
    const folders = scan.foldersFromText(cmd);
    const source = /run-crew\.cmd/i.test(String(cmd)) ? 'run-crew' : 'process';
    for (const f of folders) add(f, source);
  }
  const actions = [...(taskActions || [])];
  if (scanResult && scanResult.groups) {
    for (const t of scanResult.groups.scheduledTasks || []) {
      for (const a of t.actions || []) actions.push(a);
    }
  }
  for (const a of actions) {
    const text = [a.execute, a.arguments, a.workingDirectory].filter(Boolean).join(' ');
    for (const f of scan.foldersFromText(text, a.workingDirectory)) add(f, 'scheduled-task');
  }
  const candidates = [...map.values()].filter((c) => c.isCrew || c.manifestDir || c.dataFiles);
  for (const c of candidates) scoreLocateCandidate(c, { launcherDir: currentDir, wellKnown: knownInstalls });
  candidates.sort((a, b) => b.score - a.score || String(a.path).localeCompare(String(b.path)));
  const recommended = candidates[0] || null;
  const launcherIsInstall = !!(currentDir && recommended && sameDir(currentDir, recommended.path));
  let message = '';
  if (currentDir && launcherIsInstall) {
    message = 'The uninstaller is running from the install folder ' + path.resolve(currentDir) + '.';
  } else if (currentDir && recommended) {
    message = 'The live install appears to be ' + recommended.path
      + ' (from ' + (recommended.sources.join(', ') || 'scan') + '). '
      + 'You started the uninstaller from ' + path.resolve(currentDir)
      + ', which looks like a source or extract folder, not the live install. '
      + 'That folder will not be deleted unless it is the install.';
  } else if (recommended) {
    message = 'The live install appears to be ' + recommended.path + '.';
  } else if (currentDir) {
    message = 'You started the uninstaller from ' + path.resolve(currentDir) + '. No other live install was found.';
  }
  return {
    candidates,
    recommended,
    launcherDir: currentDir ? path.resolve(currentDir) : null,
    launcherIsInstall,
    message,
  };
}

function annotateScanForUninstall(scanResult, located) {
  if (!scanResult) return scanResult;
  const recommendedPath = located && located.recommended && located.recommended.path;
  const launcherDir = located && located.launcherDir;
  const folders = ((scanResult.groups && scanResult.groups.folders) || []).map((f) => {
    const rec = { ...f };
    if (recommendedPath && sameDir(f.path, recommendedPath)) {
      rec.recommended = true;
      rec.role = 'live-install';
      rec.reason = (f.reason ? f.reason + ' ' : '') + 'Recommended live install.';
      rec.defaultChecked = rec.defaultChecked !== false;
    } else if (launcherDir && sameDir(f.path, launcherDir) && !(located && located.launcherIsInstall)) {
      rec.recommended = false;
      rec.role = 'source-or-extract';
      rec.defaultChecked = false;
      rec.reason = (f.reason ? f.reason + ' ' : '') + 'Uninstaller was started from this folder, but it is not the live install. It will not be deleted.';
    } else {
      rec.role = rec.role || (looksLikeExtractOrSource(f.path) ? 'source-or-extract' : 'other');
    }
    return rec;
  });
  const groups = { ...(scanResult.groups || {}), folders };
  const items = (scanResult.items || []).map((it) => {
    if (it.type !== 'folder') return it;
    return folders.find((f) => sameDir(f.path, it.path)) || it;
  });
  return {
    ...scanResult,
    groups,
    items,
    locate: {
      recommended: recommendedPath || null,
      launcherDir: launcherDir || null,
      launcherIsInstall: !!(located && located.launcherIsInstall),
      message: (located && located.message) || '',
      candidates: (located && located.candidates) || [],
    },
  };
}

async function backupAndVerify(userData, dest, {
  dryRun = false,
  log = () => {},
  backupFn,
  folders = [],
  ...hooks
} = {}) {
  if (!dest) throw new Error('Backup path is missing. Uninstall will not continue.');
  for (const f of folders) {
    if (f && (isInside(dest, f) || path.resolve(dest) === path.resolve(f))) {
      throw new Error('Backup path must be outside the install folders. Uninstall will not continue.');
    }
  }
  log('Backing up user data to ' + dest);
  if (dryRun) return { ok: true, dryRun: true, path: dest };
  const fn = backupFn || backupMany;
  const result = await fn(userData, dest, { log, ...hooks });
  const verified = backup.verifyBackup(dest, { userData, ...hooks });
  backup.assertBackupOrThrow(verified);
  return { ...result, ok: true, path: result && result.path || dest, verified };
}

async function stopUntilClean({
  processes,
  rescan,
  dryRun = false,
  maxTries = 3,
  selfPid = process.pid,
  selfPpid = process.ppid,
  platform = process.platform,
  run,
  log = () => {},
  ...fsHooks
} = {}) {
  const actions = [];
  const excluded = excludedUninstallPids(processes, { selfPid, selfPpid });
  let current = processes || [];
  let stillRunning = [];
  let tries = 0;
  for (let i = 1; i <= maxTries; i++) {
    tries = i;
    log('Stopping Crew processes (run-crew loops, then tray, then servers), attempt ' + i + ' of ' + maxTries);
    const stopped = await stopSelectedProcesses(current, { dryRun, platform, run, selfPid, selfPpid, ...fsHooks });
    actions.push(...stopped);
    if (dryRun) return { actions, stillRunning: [], tries, excluded };
    let next = null;
    try { next = typeof rescan === 'function' ? await rescan() : null; } catch { next = null; }
    if (!next) {
      stillRunning = [];
      break;
    }
    // A fresh scan is the source of truth: do not hide PIDs we already tried to stop.
    stillRunning = stillRunningFromScan(next, { excludedPids: excluded, stoppedPids: [] });
    if (!stillRunning.length) break;
    current = stillRunning;
    actions.push({ action: 'rescan', try: i, stillRunning: stillRunning.length });
  }
  return { actions, stillRunning, tries, excluded };
}

async function executeUninstallSteps({
  folders,
  preview,
  dataMode = 'backup',
  dryRun = false,
  backupPath,
  alreadyVerifiedBackup = false,
  launcherDir,
  located,
  processes,
  artifacts,
  userData,
  rescan,
  maxStopTries = 3,
  selfPid = process.pid,
  selfPpid = process.ppid,
  log = () => {},
  platform = process.platform,
  run,
  env = process.env,
  homedir = os.homedir(),
  backupFn,
  cwd,
  scriptPath,
  execPath,
  sourceRoot,
  tmpdir,
  copyFile,
  mkdir,
  exists,
  ...fsHooks
} = {}) {
  const actions = [];
  let backupResult = null;
  const dest = backupPath || (preview && preview.backupPath);
  const existsFn = exists || fsHooks.exists || fs.existsSync;
  if (dataMode === 'backup') {
    if (alreadyVerifiedBackup && dest && existsFn(dest)) {
      const verified = backup.verifyBackup(dest, { userData, exists: existsFn, ...fsHooks });
      backup.assertBackupOrThrow(verified);
      backupResult = { ok: true, path: dest, verified: true, reused: true };
      actions.push({ action: 'backup', path: dest, reused: true });
      log('Reusing verified backup at ' + dest);
    } else if (userData && userData.length) {
      backupResult = await backupAndVerify(userData, dest, { dryRun, log, backupFn, folders, platform, run, exists: existsFn, ...fsHooks });
      actions.push({ action: 'backup', path: dest, dryRun: !!dryRun, counts: backupResult && backupResult.counts });
    } else if ((folders || []).some((f) => dirHasDataFiles(f, { exists: existsFn, ...fsHooks }) > 0)) {
      throw new Error('User data was found in the install folder but could not be listed for a backup. Uninstall will not continue.');
    }
  }

  if (!dryRun && needsHandoff(folders, { cwd: cwd || process.cwd(), scriptPath: scriptPath || process.argv[1], execPath: execPath || process.execPath })) {
    const copied = copyUninstallerToTemp({ sourceRoot, tmpdir, mkdir, copyFile, exists: existsFn });
    return {
      ok: true,
      handedOff: true,
      phase: 'handoff',
      tempDir: copied.dir,
      copied: copied.copied,
      backup: backupResult,
      actions,
      stillRunning: [],
    };
  }

  for (const folder of folders || []) {
    actions.push({ action: 'stop-flag', path: path.join(folder, 'crew.stop'), dryRun: !!dryRun });
    if (!dryRun) {
      writeStopFlag(folder, { ...fsHooks, exists: existsFn });
      log('Wrote stop flag in ' + folder + ' so run-crew.cmd will not restart');
    }
  }

  const stop = await stopUntilClean({
    processes, rescan, dryRun, maxTries: maxStopTries, selfPid, selfPpid, platform, run, log, ...fsHooks,
  });
  actions.push(...stop.actions);
  if (!dryRun && stop.stillRunning.length) {
    log('Crew processes are still running after ' + stop.tries + ' stop attempt(s). Files were not removed. A stop flag is in place so launchers should not restart.');
    return {
      ok: false,
      incomplete: true,
      reason: 'still-running',
      backup: backupResult,
      actions,
      stillRunning: stop.stillRunning,
      handedOff: false,
      excludedPids: [...stop.excluded],
    };
  }

  actions.push(...await removeSelectedArtifacts(artifacts || (preview && preview.artifacts) || [], { dryRun, platform, run, exists: existsFn, ...fsHooks }));

  const recommended = located && located.recommended;
  const confirmed = (folders || []).filter((f) => isConfirmedInstall(f, { launcherDir, recommended }));
  for (const folder of folders || []) {
    if (!confirmed.some((c) => sameDir(c, folder))) {
      const check = mayDeleteFolder(folder, { launcherDir, recommended, cwd, scriptPath, execPath });
      actions.push({ action: 'skip', path: folder, reason: check.reason || 'uninstaller-home' });
      log('Not deleting ' + folder + ' because the uninstaller was started from that folder and it is not the install.');
    }
  }

  for (const folder of confirmed) {
    const entries = previewUninstall(folder, { dataMode, env, homedir, exists: existsFn, ...fsHooks }).willDelete;
    const parts = partitionDeletes(entries.map((e) => ({ ...e, installDir: folder })));
    log('Deleting app files in ' + folder);
    actions.push(...await deleteInside(folder, parts.app, { dryRun, exists: existsFn, ...fsHooks }));
    log('Deleting user data last in ' + folder);
    actions.push(...await deleteInside(folder, parts.data, { dryRun, exists: existsFn, ...fsHooks }));
    if (parts.roots.length && dataMode !== 'keep') {
      log('Removing install folder ' + folder + ' if it is empty');
      actions.push(...await deleteInside(folder, parts.roots, { dryRun, exists: existsFn, ...fsHooks }));
    }
  }

  let finalStill = [];
  try {
    const next = typeof rescan === 'function' ? await rescan() : null;
    if (next) finalStill = stillRunningFromScan(next, { excludedPids: stop.excluded, stoppedPids: [] });
  } catch { /* best-effort final rescan */ }

  return {
    ok: true,
    handedOff: false,
    backup: backupResult,
    actions,
    stillRunning: finalStill,
    excludedPids: [...stop.excluded],
  };
}


async function runScanUninstall({
  scanResult,
  selectedIds,
  dataMode = 'backup',
  dryRun = false,
  backupPath,
  alreadyVerifiedBackup = false,
  launcherDir,
  located,
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
  maxStopTries = 3,
  backupFn,
  ...fsHooks
} = {}) {
  const preview = previewScanUninstall(scanResult, { selectedIds, dataMode, env, homedir, ...fsHooks });
  if (preview.unsafe.length) {
    throw new Error('Refusing to delete: ' + preview.unsafe.map((u) => u.path + ' (' + u.reason + ')').join('; '));
  }
  const folders = preview.folders;
  const locatedInfo = located || locateInstalls({
    currentDir: launcherDir || cwd,
    extraDirs: folders,
    scanResult,
    env,
    homedir,
    ...fsHooks,
  });
  const steps = await executeUninstallSteps({
    folders,
    preview,
    dataMode,
    dryRun,
    backupPath,
    alreadyVerifiedBackup,
    launcherDir: launcherDir || locatedInfo.launcherDir || cwd,
    located: locatedInfo,
    processes: preview.processes,
    artifacts: preview.artifacts,
    userData: preview.userData,
    rescan: typeof rescan === 'function'
      ? rescan
      : (typeof fsHooks.rescan === 'function' ? fsHooks.rescan : (dryRun ? null : async () => scanLib.scanCrew({ currentDir: folders[0], extraDirs: folders, env, homedir }))),
    maxStopTries,
    selfPid,
    selfPpid,
    log,
    platform,
    run,
    env,
    homedir,
    backupFn,
    cwd,
    scriptPath,
    execPath,
    sourceRoot,
    tmpdir,
    copyFile,
    mkdir,
    exists,
    ...fsHooks,
  });
  if (steps.backup && steps.backup.counts) {
    log('Backup counts: ' + steps.backup.counts.files + ' files, ' + steps.backup.counts.bytes + ' bytes'
      + (steps.backup.counts.skipped ? ', skipped ' + steps.backup.counts.skipped : '')
      + (steps.backup.counts.missing ? ', missing ' + steps.backup.counts.missing : ''));
  }
  return {
    ok: steps.ok !== false,
    dryRun,
    preview,
    backup: steps.backup,
    actions: steps.actions || [],
    handedOff: !!steps.handedOff,
    tempDir: steps.tempDir,
    copied: steps.copied,
    stillRunning: steps.stillRunning || [],
    excludedPids: steps.excludedPids || [],
    incomplete: steps.incomplete,
    reason: steps.reason,
    locate: locatedInfo,
  };
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
  sameDir, looksLikeExtractOrSource, dirHasDataFiles, stopFlagPaths, hasStopFlag, writeStopFlag,
  isDataOrUserRel, partitionDeletes, isConfirmedInstall, mayDeleteFolder,
  locateInstalls, annotateScanForUninstall, backupAndVerify, stopUntilClean, executeUninstallSteps,
};
