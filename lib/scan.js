'use strict';
// Read-only detection of every Claude Crew install and leftover.
// Never stops a process, never deletes, never writes the registry or disk.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { isInside } = require('./setup');

const PACKAGE_NAME_RE = /claude-?crew/i;
const CREW_SCRIPT_RE = /(?:^|[\\/\s"])(?:server\.js|crew-tray\.ps1|run-crew\.cmd|setup-wizard\.js|Start Crew\.bat|setup\.cmd)\b/i;
const TRAY_RE = /crew-tray\.ps1/i;
const PROCESS_NAMES = new Set(['node', 'node.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'conhost', 'conhost.exe', 'cmd', 'cmd.exe']);

function norm(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function containsPath(haystack, folder) {
  if (!haystack || !folder) return false;
  const h = norm(haystack);
  const f = norm(folder);
  if (!f) return false;
  return h === f || h.includes(f + '/') || h.includes(f + ' ') || h.includes('"' + f) || h.startsWith(f);
}

function idOf(type, key) {
  return type + ':' + String(key || '').replace(/\\/g, '/');
}

function isCrewFolder(dir, {
  exists = fs.existsSync,
  readFile = fs.readFileSync,
} = {}) {
  const root = path.resolve(dir || '');
  if (!root || !exists(root)) return { ok: false, markers: [] };
  const markers = [];
  const has = (rel) => exists(path.join(root, rel));
  if (has('server.js')) markers.push('server.js');
  if (has('crew-tray.ps1')) markers.push('crew-tray.ps1');
  if (has('Start Crew.bat')) markers.push('Start Crew.bat');
  if (has('run-crew.cmd')) markers.push('run-crew.cmd');
  if (has('setup.cmd')) markers.push('setup.cmd');
  if (has('uninstall.cmd')) markers.push('uninstall.cmd');
  if (has('install-manifest.json')) markers.push('install-manifest.json');
  if (has('crew.config.json')) markers.push('crew.config.json');
  if (has('INSTALL.bat') || has('install.ps1')) markers.push('legacy-installer');
  const pkgFile = path.join(root, 'package.json');
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFile(pkgFile, 'utf8'));
      if (pkg && PACKAGE_NAME_RE.test(String(pkg.name || ''))) markers.push('package.json:' + pkg.name);
    } catch { /* ignore */ }
  }
  const hasCore = markers.includes('server.js') || markers.includes('crew-tray.ps1');
  const hasCompanion = markers.some((m) => m !== 'server.js');
  const named = markers.some((m) => m.startsWith('package.json:'));
  const ok = (hasCore && hasCompanion) || (named && hasCore);
  return { ok, markers, path: root };
}

function wellKnownFolders({
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  exists = fs.existsSync,
  readdir = (p) => fs.readdirSync(p),
  extra = [],
} = {}) {
  const home = env.USERPROFILE || env.HOME || homedir;
  const out = [
    path.join(home, 'ClaudeCrew'),
    path.join(home, 'Projects', 'claudecrew'),
    path.join(home, 'Projects', 'ClaudeCrew'),
  ];
  if (platform === 'win32' || /^[A-Za-z]:/.test(String(env.SystemDrive || ''))) {
    const drive = env.SystemDrive || 'C:';
    out.push(path.join(drive + path.sep, 'Crew'));
    out.push(path.join(drive + path.sep, 'ClaudeCrew'));
  } else {
    out.push(path.join(path.sep, 'Crew'));
  }
  const downloads = path.join(home, 'Downloads');
  if (exists(downloads)) {
    let names = [];
    try { names = readdir(downloads); } catch { names = []; }
    for (const name of names) {
      if (/^claudecrew-main/i.test(name) || /^claudecrew-.*-(main|master|crew-mods)$/i.test(name)) {
        out.push(path.join(downloads, name));
      }
    }
  }
  for (const e of extra || []) if (e) out.push(e);
  return [...new Set(out.map((p) => path.resolve(p)))];
}

function outsideProfile(target, home) {
  if (!target) return false;
  try {
    const abs = path.resolve(target);
    const root = path.resolve(home);
    return abs !== root && !isInside(abs, root);
  } catch { return true; }
}

function extractPaths(text) {
  const s = String(text || '');
  const found = [];
  const re = /"([A-Za-z]:[^"]+)"|([A-Za-z]:\\[^\s"']+)|"(\/[^"]+)"|(\/(?:home|Users|Users\/[^/\s]+|tmp|workspace)[^\s"']+)/g;
  let m;
  while ((m = re.exec(s))) {
    found.push(m[1] || m[2] || m[3] || m[4]);
  }
  return found;
}

function foldersFromText(text, extraHint) {
  const paths = extractPaths(text);
  if (extraHint) paths.push(extraHint);
  const folders = [];
  for (const p of paths) {
    if (!p) continue;
    const abs = path.resolve(p);
    const base = path.basename(abs).toLowerCase();
    if (['server.js', 'crew-tray.ps1', 'run-crew.cmd', 'setup-wizard.js', 'setup.cmd', 'uninstall.cmd', 'start crew.bat', 'install.ps1', 'install.bat'].includes(base)) {
      folders.push(path.dirname(abs));
    } else {
      folders.push(abs);
    }
  }
  return folders;
}

function matchProcess(proc, crewFolders) {
  const name = String(proc.name || proc.Name || '').toLowerCase();
  if (!PROCESS_NAMES.has(name)) return null;
  const cmd = String(proc.commandLine || proc.CommandLine || '');
  const exe = String(proc.executablePath || proc.ExecutablePath || '');
  const hay = cmd + ' ' + exe;
  const inside = crewFolders.some((f) => containsPath(cmd, f) || containsPath(exe, f));
  const tray = TRAY_RE.test(hay);
  const script = CREW_SCRIPT_RE.test(hay);
  const isNode = name === 'node' || name === 'node.exe';
  const isPs = /powershell|pwsh/.test(name);
  const isHost = /conhost|cmd/.test(name);
  if (tray && (isPs || isHost || inside)) {
    return { kind: 'tray', reason: 'command line names crew-tray.ps1' };
  }
  if (isNode && script && inside) {
    return { kind: 'server', reason: 'node process running Crew inside a Crew folder' };
  }
  if (isNode && inside && /server\.js/i.test(hay)) {
    return { kind: 'server', reason: 'node + server.js + Crew folder' };
  }
  if (inside && script && (isPs || isHost)) {
    return { kind: 'helper', reason: 'shell process whose command line points at Crew' };
  }
  return null;
}

function procPid(proc) {
  return Number(proc.pid || proc.ProcessId || 0);
}

function procParentPid(proc) {
  return Number(proc.parentPid || proc.ParentProcessId || proc.ppid || 0);
}

function isNodeProc(proc) {
  const name = String(proc.name || proc.Name || '').toLowerCase();
  return name === 'node' || name === 'node.exe';
}

function isShellProc(proc) {
  const name = String(proc.name || proc.Name || '').toLowerCase();
  return /^(powershell|powershell\.exe|pwsh|pwsh\.exe|conhost|conhost\.exe|cmd|cmd\.exe)$/.test(name);
}

function commandLineOf(proc) {
  return String(proc.commandLine || proc.CommandLine || '');
}

// npx MCP servers (desktop-commander, server-pdf, …) must never match as Crew.
function looksLikeMcp(proc) {
  const hay = commandLineOf(proc) + ' ' + String(proc.executablePath || proc.ExecutablePath || '');
  return /desktop-commander|server-pdf|@modelcontextprotocol|\\npx-cli\.js\b|\/npx-cli\.js\b|\bnpx\s/i.test(hay);
}

function commandHasServerJs(proc) {
  return /server\.js/i.test(commandLineOf(proc));
}

function readCrewPort(dir, {
  exists = fs.existsSync,
  readFile = fs.readFileSync,
} = {}) {
  const cfgPath = path.join(dir, 'crew.config.json');
  if (!exists(cfgPath)) return 7777;
  try {
    const cfg = JSON.parse(readFile(cfgPath, 'utf8'));
    const port = Number(cfg && cfg.settings && cfg.settings.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  } catch { /* default */ }
  return 7777;
}

function childrenByParent(processes) {
  const map = new Map();
  for (const proc of processes) {
    const pp = procParentPid(proc);
    if (!map.has(pp)) map.set(pp, []);
    map.get(pp).push(proc);
  }
  return map;
}

function processesByPid(processes) {
  const map = new Map();
  for (const proc of processes) {
    const pid = procPid(proc);
    if (pid) map.set(pid, proc);
  }
  return map;
}

// Seed = already-detected Crew helpers and tray processes. Walk shell
// descendants (cmd / conhost / powershell) so a node child of a nested
// conhost still matches. Do not walk into node children — those may have
// spawned unrelated npx MCP servers.
function expandHelperPids(seedPids, processes) {
  const helperPids = new Set([...seedPids].map(Number).filter(Boolean));
  const kids = childrenByParent(processes);
  const stack = [...helperPids];
  while (stack.length) {
    const pid = stack.pop();
    for (const child of kids.get(pid) || []) {
      const cid = procPid(child);
      if (!cid || helperPids.has(cid)) continue;
      if (isShellProc(child)) {
        helperPids.add(cid);
        stack.push(cid);
      }
    }
  }
  return helperPids;
}

function isDescendantOfHelper(proc, helperPids, byPid) {
  const seen = new Set();
  let pid = procParentPid(proc);
  while (pid && !seen.has(pid)) {
    if (helperPids.has(pid)) return true;
    seen.add(pid);
    const parent = byPid.get(pid);
    if (!parent) return false;
    pid = procParentPid(parent);
  }
  return false;
}

function runningPidSet(inventory, processes) {
  const raw = inventory && inventory.runningPids;
  if (Array.isArray(raw) && raw.length) {
    return new Set(raw.map(Number).filter(Boolean));
  }
  // No full live-PID list. Unknown parents are not assumed gone —
  // Claude.exe may simply be outside the node/powershell/cmd inventory.
  return null;
}

function parentIsGone(proc, livePids) {
  const pp = procParentPid(proc);
  if (!pp) return true;
  if (!livePids) return false;
  return !livePids.has(pp);
}

function matchNodeChildOfHelper(proc, helperPids) {
  if (!isNodeProc(proc) || looksLikeMcp(proc)) return null;
  const pp = procParentPid(proc);
  if (!pp || !helperPids.has(pp)) return null;
  return { kind: 'server', reason: 'node.exe child of a Crew helper or tray process' };
}

function matchPortOwner(proc, port, helperPids, byPid, livePids) {
  if (!isNodeProc(proc) || looksLikeMcp(proc)) return null;
  if (!commandHasServerJs(proc)) return null;
  const descendant = isDescendantOfHelper(proc, helperPids, byPid);
  const gone = parentIsGone(proc, livePids);
  if (!descendant && !gone) return null;
  const why = descendant
    ? 'descendant of a Crew helper'
    : 'parent process is gone';
  return { kind: 'server', reason: 'owns configured Crew port ' + port + ' (' + why + ')' };
}

function matchShortcut(link, crewFolders) {
  const target = link.target || '';
  const args = link.args || link.arguments || '';
  const workdir = link.workdir || link.workingDirectory || '';
  const hay = [target, args, workdir, link.path || ''].join(' ');
  const inside = crewFolders.some((f) => containsPath(target, f) || containsPath(args, f) || containsPath(workdir, f));
  const named = /claude\s*crew/i.test(path.basename(link.path || '')) || /claude\s*crew/i.test(hay);
  const script = CREW_SCRIPT_RE.test(hay) || TRAY_RE.test(hay);
  if (inside || (script && (inside || named))) {
    let group = 'shortcut';
    const loc = norm(link.path || link.location || '');
    if (loc.includes('/startup')) group = 'startupShortcut';
    else if (loc.includes('/desktop')) group = 'desktopShortcut';
    else if (loc.includes('user pinned') && loc.includes('taskbar')) group = 'taskbarShortcut';
    else if (loc.includes('start menu')) group = 'startMenuShortcut';
    return { kind: group, reason: inside ? 'shortcut target is a Crew folder' : 'shortcut names a Crew script' };
  }
  return null;
}

function matchTask(task, crewFolders) {
  const actions = Array.isArray(task.actions) ? task.actions : [];
  const hay = [task.name, task.path, ...actions.map((a) => [a.execute, a.arguments, a.workingDirectory].join(' '))].join(' ');
  const inside = crewFolders.some((f) => containsPath(hay, f));
  const script = CREW_SCRIPT_RE.test(hay) || TRAY_RE.test(hay);
  const named = /^claude crew$/i.test(String(task.name || '').trim());
  if (inside || script || named) {
    return { kind: 'scheduledTask', reason: named && !inside && !script ? 'scheduled task named Claude Crew' : 'scheduled task action references Crew' };
  }
  return null;
}

function matchRunKey(entry, crewFolders) {
  const hay = [entry.name, entry.data, entry.key].join(' ');
  const inside = crewFolders.some((f) => containsPath(entry.data, f));
  const script = CREW_SCRIPT_RE.test(hay) || TRAY_RE.test(hay);
  const named = /claude\s*crew/i.test(String(entry.name || ''));
  if (inside || script || named) {
    return { kind: 'runKey', reason: inside || script ? 'Run key value references Crew' : 'Run key named Claude Crew' };
  }
  return null;
}

function commonLocation(p) {
  const n = norm(p);
  return n.includes('/programdata/') || n.includes('/all users/') || /(^|\/)hklm:/.test(n) || n.includes('/public/');
}

async function collectWindowsInventory({
  platform = process.platform,
  scriptPath,
  spawnFn = spawn,
  timeout = 60000,
  inventory,
} = {}) {
  if (inventory) return inventory;
  if (platform !== 'win32') return { processes: [], shortcuts: [], tasks: [], runKeys: [], readOnly: true };
  if (!scriptPath) throw new Error('scan-inventory.ps1 path is required on Windows');
  return new Promise((resolve, reject) => {
    const child = spawnFn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], { windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } reject(new Error('inventory timed out')); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout || '{}');
        parsed.processes = [].concat(parsed.processes || []);
        parsed.shortcuts = [].concat(parsed.shortcuts || []);
        parsed.tasks = [].concat(parsed.tasks || []);
        parsed.runKeys = [].concat(parsed.runKeys || []);
        parsed.listeners = [].concat(parsed.listeners || []);
        parsed.runningPids = [].concat(parsed.runningPids || []).map(Number).filter(Boolean);
        parsed.readOnly = true;
        resolve(parsed);
      } catch (err) {
        reject(new Error('inventory parse failed: ' + (err.message || '') + (stderr ? ' ' + stderr : '') + (code ? ' code ' + code : '')));
      }
    });
  });
}

function itemBase(type, rec, home, extra = {}) {
  const target = rec.path || rec.data || rec.name || '';
  const outside = rec.hive === 'HKLM' || commonLocation(target) || (target && outsideProfile(target, home) && type !== 'process' && type !== 'scheduledTask' && type !== 'runKey');
  const hiveOutside = rec.hive === 'HKLM';
  const readOnly = !!rec.readOnly || hiveOutside || (type !== 'process' && commonLocation(target) && /common|programdata|public|hklm/i.test(norm(target) + ' ' + (rec.hive || '')));
  const defaultChecked = !hiveOutside && !outsideProfile(
    type === 'folder' ? rec.path
      : type === 'shortcut' ? rec.path
        : type === 'runKey' && rec.hive === 'HKLM' ? path.join(path.sep, 'Windows') // force outside
          : (rec.path || home),
    home,
  ) && rec.hive !== 'HKLM';
  return {
    id: rec.id,
    type,
    defaultChecked: extra.defaultChecked != null ? extra.defaultChecked : (defaultChecked && !readOnly),
    outsideProfile: extra.outsideProfile != null ? extra.outsideProfile : (rec.hive === 'HKLM' || (rec.path ? outsideProfile(rec.path, home) : false)),
    readOnly: extra.readOnly != null ? extra.readOnly : readOnly,
    ...rec,
  };
}

async function scanCrew({
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  exists = fs.existsSync,
  readdir = (p) => fs.readdirSync(p),
  readFile = fs.readFileSync,
  currentDir,
  extraDirs = [],
  inventory,
  collect,
  scriptPath,
  spawnFn,
} = {}) {
  const home = path.resolve(env.USERPROFILE || env.HOME || homedir);
  const raw = collect
    ? await collect()
    : await collectWindowsInventory({ platform, scriptPath, spawnFn, inventory });
  const processes = raw.processes || [];
  const shortcuts = raw.shortcuts || [];
  const tasks = raw.tasks || [];
  const runKeys = raw.runKeys || [];

  const hinted = [];
  for (const proc of processes) hinted.push(...foldersFromText(proc.commandLine), ...foldersFromText(proc.executablePath));
  for (const s of shortcuts) hinted.push(...foldersFromText(s.target), ...foldersFromText(s.args), s.workdir);
  for (const t of tasks) {
    for (const a of t.actions || []) hinted.push(...foldersFromText(a.execute), ...foldersFromText(a.arguments), a.workingDirectory);
  }
  for (const r of runKeys) hinted.push(...foldersFromText(r.data));
  if (currentDir) hinted.push(currentDir);

  const candidates = wellKnownFolders({ env, homedir, platform, exists, readdir, extra: [...extraDirs, ...hinted.filter(Boolean)] });
  const folders = [];
  const seen = new Set();
  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    if (seen.has(norm(resolved))) continue;
    const verdict = isCrewFolder(resolved, { exists, readFile });
    if (!verdict.ok) continue;
    seen.add(norm(resolved));
    const outside = outsideProfile(resolved, home);
    folders.push(itemBase('folder', {
      id: idOf('folder', resolved),
      path: resolved,
      markers: verdict.markers,
      source: 'scan',
    }, home, { outsideProfile: outside, defaultChecked: !outside, readOnly: false }));
  }

  const crewPaths = folders.map((f) => f.path);
  const matches = new Map();
  for (const proc of processes) {
    const match = matchProcess(proc, crewPaths);
    const pid = procPid(proc);
    if (match && pid) matches.set(pid, { proc, match });
  }

  const seedHelpers = [];
  for (const { proc, match } of matches.values()) {
    if (match.kind === 'helper' || match.kind === 'tray') seedHelpers.push(procPid(proc));
  }
  const helperPids = expandHelperPids(seedHelpers, processes);
  const byPid = processesByPid(processes);
  const livePids = runningPidSet(raw, processes);

  // (a) node.exe whose parent is a detected Crew helper or tray (after
  // walking shell descendants of those helpers).
  for (const proc of processes) {
    const pid = procPid(proc);
    if (!pid || matches.has(pid)) continue;
    const match = matchNodeChildOfHelper(proc, helperPids);
    if (match) matches.set(pid, { proc, match });
  }

  // (b) PID that owns each detected folder's configured port (crew.config.json,
  // default 7777), only if the command line contains server.js AND the process
  // is a descendant of a Crew helper or its parent is gone.
  const listeners = raw.listeners || [];
  for (const folder of folders) {
    const port = readCrewPort(folder.path, { exists, readFile });
    const owners = new Set();
    for (const lis of listeners) {
      if (Number(lis.port) === port && Number(lis.pid)) owners.add(Number(lis.pid));
    }
    for (const pid of owners) {
      if (matches.has(pid)) continue;
      const proc = byPid.get(pid);
      if (!proc) continue;
      const match = matchPortOwner(proc, port, helperPids, byPid, livePids);
      if (match) matches.set(pid, { proc, match });
    }
  }

  const processItems = [];
  const trayItems = [];
  const seenPid = new Set();
  for (const { proc, match } of matches.values()) {
    const pid = procPid(proc);
    if (!pid || seenPid.has(pid)) continue;
    seenPid.add(pid);
    const rec = itemBase('process', {
      id: idOf('process', String(pid)),
      pid,
      parentPid: procParentPid(proc) || undefined,
      name: proc.name,
      commandLine: proc.commandLine || '',
      executablePath: proc.executablePath || '',
      kind: match.kind,
      reason: match.reason,
    }, home, { defaultChecked: true, outsideProfile: false, readOnly: false });
    if (match.kind === 'tray') {
      trayItems.push({ ...rec, type: 'tray', id: idOf('tray', String(pid)) });
    } else {
      processItems.push(rec);
    }
  }

  const shortcutItems = [];
  for (const s of shortcuts) {
    const match = matchShortcut(s, crewPaths);
    if (!match) continue;
    const p = s.path;
    const outside = !p ? false : (outsideProfile(p, home) || commonLocation(p));
    shortcutItems.push(itemBase('shortcut', {
      id: idOf('shortcut', p),
      path: p,
      target: s.target || '',
      args: s.args || '',
      workdir: s.workdir || '',
      kind: match.kind,
      reason: match.reason,
    }, home, { outsideProfile: outside, defaultChecked: !outside, readOnly: commonLocation(p) }));
  }

  const taskItems = [];
  for (const t of tasks) {
    const match = matchTask(t, crewPaths);
    if (!match) continue;
    taskItems.push(itemBase('scheduledTask', {
      id: idOf('task', (t.path || '') + t.name),
      name: t.name,
      path: t.path || '',
      actions: t.actions || [],
      reason: match.reason,
    }, home, { defaultChecked: true, outsideProfile: false, readOnly: false }));
  }

  const runItems = [];
  for (const r of runKeys) {
    const match = matchRunKey(r, crewPaths);
    if (!match) continue;
    const machine = r.hive === 'HKLM';
    runItems.push(itemBase('runKey', {
      id: idOf('runKey', (r.hive || '') + ':' + r.key + ':' + r.name),
      hive: r.hive,
      key: r.key,
      name: r.name,
      data: r.data,
      reason: match.reason,
    }, home, { defaultChecked: !machine, outsideProfile: machine, readOnly: machine }));
  }

  return {
    readOnly: true,
    home,
    generatedAt: new Date().toISOString(),
    groups: {
      folders,
      processes: processItems,
      tray: trayItems,
      shortcuts: shortcutItems,
      scheduledTasks: taskItems,
      runKeys: runItems,
    },
    items: [...folders, ...processItems, ...trayItems, ...shortcutItems, ...taskItems, ...runItems],
  };
}

function selectedFromScan(scan, selectedIds) {
  const want = new Set(selectedIds && selectedIds.length ? selectedIds : scan.items.filter((i) => i.defaultChecked).map((i) => i.id));
  return scan.items.filter((i) => want.has(i.id));
}

module.exports = {
  PACKAGE_NAME_RE, CREW_SCRIPT_RE, TRAY_RE,
  isCrewFolder, wellKnownFolders, outsideProfile, containsPath, extractPaths,
  foldersFromText, matchProcess, matchShortcut, matchTask, matchRunKey,
  collectWindowsInventory, scanCrew, selectedFromScan, idOf,
  readCrewPort, expandHelperPids, procPid, procParentPid,
};
