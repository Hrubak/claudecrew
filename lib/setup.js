'use strict';
// Shared setup-wizard helpers: source, folder checks, install, switch-source,
// and the install manifest. No secrets. All commands use argv lists, never a shell.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PRESETS = {
  hast3: { id: 'hast3', label: 'hast3/claudecrew', url: 'https://github.com/hast3/claudecrew.git', defaultBranch: 'main' },
  hrubak: { id: 'hrubak', label: 'Hrubak/claudecrew', url: 'https://github.com/Hrubak/claudecrew.git', defaultBranch: 'crew-mods' },
};
const DEFAULT_SOURCE = 'hast3';
const MANIFEST_NAME = 'install-manifest.json';
const MODEL_CHOICES = ['opus', 'sonnet', 'haiku'];
const EFFORT_CHOICES = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'];

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      windowsHide: true,
      timeout: opts.timeout || 60000,
      maxBuffer: 8 * 1024 * 1024,
      cwd: opts.cwd,
      env: opts.env,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      });
    });
  });
}

function defaultInstallDir({ homedir = os.homedir(), env = process.env } = {}) {
  return path.join(env.USERPROFILE || env.HOME || homedir, 'ClaudeCrew');
}

// Windows `"%~dp0"` ends in a backslash; argv parsing turns `\"` into a literal
// quote, so --dir can arrive as a path ending in `"`. Strip stray quotes and
// trailing separators before resolve. Drive roots like C:\ are kept.
function normalizeInstallDir(input, { resolvePath = path.resolve } = {}) {
  let s = String(input == null ? '' : input).trim();
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/^["']+|["']+$/g, '').trim();
    if (next === s) break;
    s = next;
  }
  s = s.replace(/"+$/g, '').replace(/'+$/g, '').trim();
  if (!s) return s;
  if (/^[A-Za-z]:[\\/]*$/.test(s)) return s.slice(0, 2) + '\\';
  if (/^[\\/]+$/.test(s)) return '/';
  s = s.replace(/[\\/]+$/, '');
  if (!s) return '/';
  try { return resolvePath(s); } catch { return s; }
}

function segments(p) {
  return String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
}

function specialFolders({ env = process.env, homedir = os.homedir(), tmpdir = os.tmpdir(), platform = process.platform } = {}) {
  const home = env.USERPROFILE || env.HOME || homedir;
  const temps = [
    tmpdir,
    env.TEMP,
    env.TMP,
    platform === 'win32' ? path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'Temp') : '/tmp',
    path.join(home, 'AppData', 'Local', 'Temp'),
  ].filter(Boolean);
  return {
    home,
    downloads: path.join(home, 'Downloads'),
    temps: [...new Set(temps.map((p) => path.resolve(p)))],
  };
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function isDownloadsOrTemp(inputPath, opts = {}) {
  const special = specialFolders(opts);
  const resolved = path.resolve(inputPath);
  const segs = segments(resolved).map((s) => s.toLowerCase());
  if (segs.includes('downloads')) return 'downloads';
  if (isInside(resolved, special.downloads)) return 'downloads';
  if (segs.includes('temp') || segs.includes('tmp')) return 'temp';
  if (special.temps.some((t) => isInside(resolved, t))) return 'temp';
  return null;
}

function looksLikeZipExtract(dir, { exists = fs.existsSync, readdir = (p) => fs.readdirSync(p) } = {}) {
  const name = path.basename(dir || '');
  if (exists(path.join(dir, '.git'))) return false;
  const githubExtract = /-(main|master|crew-mods)$/i.test(name) || /^claudecrew-.*-(main|master|crew-mods)$/i.test(name);
  const hasCrew = exists(path.join(dir, 'server.js')) && (
    exists(path.join(dir, 'INSTALL.bat')) ||
    exists(path.join(dir, 'install.ps1')) ||
    exists(path.join(dir, 'package.json'))
  );
  let motw = false;
  try {
    motw = readdir(dir).some((n) => String(n).endsWith(':Zone.Identifier') || String(n).endsWith('.Zone.Identifier'));
  } catch { /* missing */ }
  return !!(githubExtract || (hasCrew && !exists(path.join(dir, '.git')) && (githubExtract || exists(path.join(dir, 'INSTALL.bat')) || motw)));
}

function isGitUrl(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  if (/\.zip(\?|$)/i.test(u) || /\/archive\//i.test(u)) return false;
  return /^(https?:\/\/|git@|ssh:\/\/)/i.test(u);
}

function resolveSource({ kind, url, branch }) {
  const preset = PRESETS[kind];
  const resolvedUrl = preset ? preset.url : String(url || '').trim();
  const resolvedBranch = String(branch || (preset ? preset.defaultBranch : '') || '').trim();
  if (!isGitUrl(resolvedUrl)) throw new Error('Enter a git URL (https or ssh), not a ZIP or /archive/ link.');
  if (!resolvedBranch) throw new Error('Choose a branch.');
  return { url: resolvedUrl, branch: resolvedBranch, preset: preset ? preset.id : 'custom' };
}

async function listBranches(url, { run = execFileP } = {}) {
  if (!isGitUrl(url)) throw new Error('Invalid git URL.');
  const r = await run('git', ['ls-remote', '--heads', url], { timeout: 30000 });
  if (!r.ok) throw new Error(r.stderr || r.stdout || 'Could not list branches. Check the URL and your network.');
  return r.stdout.split('\n').map((line) => {
    const m = line.match(/refs\/heads\/(\S+)/);
    return m ? m[1] : null;
  }).filter(Boolean);
}

async function branchExists(url, branch, { run = execFileP } = {}) {
  if (!isGitUrl(url) || !branch) return false;
  const r = await run('git', ['ls-remote', '--heads', url, branch], { timeout: 30000 });
  return r.ok && /refs\/heads\//.test(r.stdout);
}

async function checkWritable(target, { exists = fs.existsSync, mkdir = fs.mkdirSync, writeFile = fs.writeFileSync, unlink = fs.unlinkSync, rmdir = fs.rmdirSync, lstat = (p) => fs.lstatSync(p) } = {}) {
  let probeDir = target;
  let created = false;
  try {
    if (!exists(target)) {
      let parent = path.dirname(path.resolve(target));
      while (parent && !exists(parent)) parent = path.dirname(parent);
      if (!parent || !exists(parent)) return { ok: false, error: 'The parent folder does not exist.' };
      const st = lstat(parent);
      if (!st.isDirectory()) return { ok: false, error: 'The parent path is not a folder.' };
      probeDir = parent;
    } else if (!lstat(target).isDirectory()) {
      return { ok: false, error: 'That path is a file, not a folder.' };
    }
    const probe = path.join(probeDir, `.crew-write-test-${process.pid}-${Date.now()}`);
    writeFile(probe, 'ok');
    unlink(probe);
    return { ok: true };
  } catch (err) {
    if (created) try { rmdir(target); } catch { /* ignore */ }
    return { ok: false, error: err.message || 'Crew cannot write to this folder.' };
  }
}

async function checkFolder(inputPath, {
  exists = fs.existsSync,
  readdir = (p) => fs.readdirSync(p),
  lstat = (p) => fs.lstatSync(p),
  run = execFileP,
  env = process.env,
  homedir = os.homedir(),
  tmpdir = os.tmpdir(),
  platform = process.platform,
  expectedUrl,
  expectedBranch,
} = {}) {
  const errors = [];
  const warnings = [];
  const raw = normalizeInstallDir(String(inputPath || '').trim()) || '';
  if (!raw) return { ok: false, block: true, errors: ['Choose a folder to continue. Type a path or click Browse…'], warnings, writable: false, exists: false, empty: true, kind: 'empty-path' };

  const resolved = path.resolve(raw);
  if (exists(resolved) && !lstat(resolved).isDirectory()) {
    return { ok: false, block: true, errors: ['That path is a file, not a folder.'], warnings, writable: false, exists: true, empty: false, kind: 'file' };
  }

  const zone = isDownloadsOrTemp(resolved, { env, homedir, tmpdir, platform });
  if (zone === 'downloads') {
    errors.push('Blocked: Downloads folder. Crew should not be installed in Downloads (or a folder inside it). Choose a lasting location such as ' + defaultInstallDir({ homedir, env }) + '.');
    return { ok: false, block: true, errors, warnings, writable: false, exists: exists(resolved), empty: false, kind: 'downloads', path: resolved };
  }
  if (zone === 'temp') {
    errors.push('Blocked: temporary folder. Temp is not a lasting install location. Choose a folder such as ' + defaultInstallDir({ homedir, env }) + '.');
    return { ok: false, block: true, errors, warnings, writable: false, exists: exists(resolved), empty: false, kind: 'temp', path: resolved };
  }

  if (exists(resolved) && looksLikeZipExtract(resolved, { exists, readdir })) {
    errors.push('Blocked: ZIP-extracted folder. This looks like a GitHub archive extract, not a git clone. Pick an empty folder instead. Crew is always installed as a git clone.');
    return { ok: false, block: true, errors, warnings, writable: false, exists: true, empty: false, kind: 'zip', path: resolved };
  }

  const writ = await checkWritable(resolved, { exists, lstat });
  if (!writ.ok) {
    errors.push('Blocked: not writable. ' + (writ.error || 'Crew cannot write to this folder.'));
    return { ok: false, block: true, errors, warnings, writable: false, exists: exists(resolved), empty: false, kind: 'unwritable', path: resolved };
  }

  const present = exists(resolved);
  let empty = true;
  let kind = present ? 'empty' : 'missing';
  let git = null;
  if (present) {
    const names = readdir(resolved).filter((n) => n !== 'desktop.ini' && n !== '.DS_Store');
    empty = names.length === 0;
    if (exists(path.join(resolved, '.git'))) {
      kind = 'git';
      const rem = await run('git', ['-C', resolved, 'remote', 'get-url', 'origin']);
      const br = await run('git', ['-C', resolved, 'branch', '--show-current']);
      git = { url: rem.ok ? rem.stdout : '', branch: br.ok ? br.stdout : '' };
      if (expectedUrl && git.url && normalizeGitUrl(git.url) !== normalizeGitUrl(expectedUrl)) {
        errors.push('This folder is already a git clone of ' + git.url + (git.branch ? ' (' + git.branch + ')' : '') + '. Pick another folder, or use Settings > General > Switch source after install.');
        return { ok: false, block: true, errors, warnings, writable: true, exists: true, empty: false, kind, git, path: resolved };
      }
      if (expectedBranch && git.branch && git.branch !== expectedBranch) {
        warnings.push('This clone is on branch "' + git.branch + '", not "' + expectedBranch + '". Next will use the existing clone as-is. You can switch later in Settings.');
      }
    } else if (!empty) {
      kind = 'nonempty';
      warnings.push('This folder is not empty. A git clone can still go here, but you may prefer a new empty folder so Crew files are not mixed in with existing ones.');
    }
  }

  return { ok: errors.length === 0, block: errors.length > 0, errors, warnings, writable: true, exists: present, empty, kind, git, path: resolved };
}

function normalizeGitUrl(url) {
  return String(url || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

async function checkCommand(cmd, args, { run = execFileP, timeout = 8000 } = {}) {
  const r = await run(cmd, args, { timeout });
  return { ok: r.ok, text: r.stdout || r.stderr, ...r };
}

async function checkPrereqs({ run = execFileP, env = process.env, nodeMin = 20 } = {}) {
  const node = await checkCommand('node', ['--version'], { run });
  const major = node.ok ? parseInt(String(node.text).replace(/^v/i, ''), 10) : 0;
  const nodeOk = node.ok && major >= nodeMin;
  const git = await checkCommand('git', ['--version'], { run });
  const claudeCmd = env.CLAUDE_PATH || 'claude';
  const claude = await checkCommand(claudeCmd, ['--version'], { run, timeout: 15000 });
  let login = { ok: false, text: '' };
  if (claude.ok) {
    login = await checkCommand(claudeCmd, ['-p', 'Reply with exactly: Claude Code is working'], { run, timeout: 90000 });
  }
  return {
    node: { ok: nodeOk, text: node.text || 'Node.js 20 or newer was not found.', version: node.text },
    git: { ok: git.ok, text: git.text || 'git was not found on PATH.' },
    claude: { ok: claude.ok, text: claude.text || 'The Claude CLI was not found.' },
    login: { ok: login.ok, text: login.ok ? 'Signed in and working.' : (login.text || 'Not signed in, or the probe did not get a reply.') },
    ready: nodeOk && git.ok && claude.ok,
    platform: process.platform,
    commands: prereqCommands({ claudeCmd: claudeCmd }),
  };
}

function detectInstall(dir, { exists = fs.existsSync, readdir = (p) => fs.readdirSync(p) } = {}) {
  const root = path.resolve(dir);
  const hasServer = exists(path.join(root, 'server.js'));
  const hasConfig = exists(path.join(root, 'crew.config.json'));
  const hasManifest = exists(path.join(root, MANIFEST_NAME));
  const hasOld = exists(path.join(root, 'INSTALL.bat')) || exists(path.join(root, 'install.ps1'));
  const hasGit = exists(path.join(root, '.git'));
  const zip = looksLikeZipExtract(root, { exists, readdir });
  const existing = hasServer && (hasConfig || hasManifest || hasOld || hasGit);
  const extractName = /-(main|master|crew-mods)$/i.test(path.basename(root)) || /^claudecrew-.*-(main|master|crew-mods)$/i.test(path.basename(root));
  let kind = 'fresh';
  if (existing && extractName && !hasGit) kind = 'zip';
  else if (existing && hasOld && !hasGit) kind = 'legacy';
  else if (existing && hasGit) kind = 'git';
  else if (existing) kind = 'legacy';
  return { existing, kind, hasServer, hasConfig, hasManifest, hasOld, hasGit, zip, path: root };
}

function readManifest(dir, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  const file = path.join(dir, MANIFEST_NAME);
  if (!exists(file)) return null;
  try { return JSON.parse(readFile(file, 'utf8')); } catch { return null; }
}

function writeManifest(dir, manifest, { writeFile = fs.writeFileSync, mkdir = fs.mkdirSync } = {}) {
  mkdir(dir, { recursive: true });
  const body = { version: 1, createdAt: new Date().toISOString(), installDir: path.resolve(dir), ...manifest };
  writeFile(path.join(dir, MANIFEST_NAME), JSON.stringify(body, null, 2), 'utf8');
  return body;
}

function writeConfig(dir, settings, { readFile = fs.readFileSync, writeFile = fs.writeFileSync, exists = fs.existsSync } = {}) {
  const dest = path.join(dir, 'crew.config.json');
  if (exists(dest)) return { written: false, path: dest };
  const examplePath = path.join(dir, 'crew.config.example.json');
  const cfg = JSON.parse(readFile(examplePath, 'utf8'));
  cfg.settings = cfg.settings || {};
  const s = settings || {};
  if (s.userName) cfg.settings.userName = s.userName;
  if (s.port) cfg.settings.port = Number(s.port);
  if (s.allowLan != null) cfg.settings.allowLan = !!s.allowLan;
  if (s.model === '' || s.model === undefined) cfg.settings.model = null;
  else if (s.model) cfg.settings.model = s.model;
  if (s.effort && EFFORT_CHOICES.includes(s.effort)) cfg.settings.effort = s.effort;
  else cfg.settings.effort = 'low';
  if (s.permissionMode && PERMISSION_MODES.includes(s.permissionMode)) cfg.settings.permissionMode = s.permissionMode;
  if (s.machineName) cfg.settings.machineName = s.machineName;
  if (s.claudePath) cfg.settings.claudePath = s.claudePath;
  writeFile(dest, JSON.stringify(cfg, null, 2), 'utf8');
  return { written: true, path: dest };
}

async function install({ dest, url, branch, settings, autostart = false, run = execFileP, exists = fs.existsSync, mkdir = fs.mkdirSync, log = () => {}, onBeforeConfig }) {
  const folder = await checkFolder(dest, { run, expectedUrl: url, expectedBranch: branch });
  if (!folder.ok && folder.kind !== 'git') throw new Error(folder.errors.join(' '));
  const dir = folder.path;
  if (folder.kind !== 'git') {
    if (!exists(dir)) mkdir(dir, { recursive: true });
    log('Cloning ' + url + ' (' + branch + ') into ' + dir);
    const clone = await run('git', ['clone', '--branch', branch, '--single-branch', url, dir], { timeout: 180000 });
    if (!clone.ok) throw new Error(clone.stderr || clone.stdout || 'git clone failed');
  } else {
    log('Using the existing git clone in ' + dir);
  }
  log('npm install');
  const npm = await run('npm', ['install'], { cwd: dir, timeout: 180000 });
  if (!npm.ok) log('npm install warning: ' + (npm.stderr || npm.stdout));
  if (typeof onBeforeConfig === 'function') await onBeforeConfig(dir, log);
  const cfg = writeConfig(dir, settings);
  log(cfg.written ? 'Wrote crew.config.json' : 'Kept existing crew.config.json');
  const created = [
    { type: 'dir', path: dir },
    { type: 'file', path: 'crew.config.json' },
    { type: 'file', path: MANIFEST_NAME },
  ];
  if (autostart) created.push({ type: 'startupShortcut', name: 'Claude Crew tray.lnk' });
  created.push({ type: 'desktopShortcut', name: 'Claude Crew.lnk' });
  const manifest = writeManifest(dir, { url, branch, autostart: !!autostart, created, source: 'setup-wizard' });
  return { dir, config: cfg, manifest };
}

async function sourceStatus(dir, { run = execFileP, exists = fs.existsSync } = {}) {
  const root = path.resolve(dir);
  if (!exists(path.join(root, '.git'))) {
    return { isGit: false, dirty: false, dirtyFiles: [], url: '', branch: '', sha: '', remote: '' };
  }
  const url = await run('git', ['-C', root, 'remote', 'get-url', 'origin']);
  const branch = await run('git', ['-C', root, 'branch', '--show-current']);
  const sha = await run('git', ['-C', root, 'rev-parse', '--short', 'HEAD']);
  const st = await run('git', ['-C', root, 'status', '--porcelain']);
  const dirtyFiles = st.ok && st.stdout ? st.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean) : [];
  return {
    isGit: true,
    url: url.stdout || '',
    branch: branch.stdout || '',
    sha: sha.stdout || '',
    remote: 'origin',
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
  };
}

async function switchSource(dir, { url, branch, run = execFileP }) {
  const src = resolveSource({ kind: 'custom', url, branch });
  const st = await sourceStatus(dir, { run });
  if (!st.isGit) throw new Error('This copy was not installed as a git clone, so it cannot switch source in place. Install a fresh clone with setup.cmd.');
  if (st.dirty) {
    const err = new Error('You have uncommitted local changes. Crew will not switch source and will not discard them.');
    err.dirtyFiles = st.dirtyFiles;
    throw err;
  }
  const exists = await branchExists(src.url, src.branch, { run });
  if (!exists) throw new Error('Branch "' + src.branch + '" was not found on ' + src.url);
  const remotes = await run('git', ['-C', dir, 'remote', '-v']);
  let remote = 'origin';
  const already = (remotes.stdout || '').split('\n').some((l) => l.includes(src.url));
  if (!already) {
    remote = 'switch';
    const named = await run('git', ['-C', dir, 'remote']);
    if ((named.stdout || '').split(/\s+/).includes('switch')) {
      await run('git', ['-C', dir, 'remote', 'set-url', 'switch', src.url]);
    } else {
      const add = await run('git', ['-C', dir, 'remote', 'add', 'switch', src.url]);
      if (!add.ok) throw new Error(add.stderr || 'Could not add git remote');
    }
  } else if (normalizeGitUrl(st.url) === normalizeGitUrl(src.url)) {
    remote = 'origin';
  }
  const fetch = await run('git', ['-C', dir, 'fetch', remote, src.branch], { timeout: 180000 });
  if (!fetch.ok) throw new Error(fetch.stderr || fetch.stdout || 'git fetch failed');
  const sw = await run('git', ['-C', dir, 'switch', '-C', src.branch, '--track', remote + '/' + src.branch]);
  if (!sw.ok) {
    const sw2 = await run('git', ['-C', dir, 'switch', src.branch]);
    if (!sw2.ok) throw new Error(sw.stderr || sw2.stderr || 'git switch failed. The branch may have diverged; Crew will not reset or discard work.');
  }
  await run('npm', ['install'], { cwd: dir, timeout: 180000 });
  return sourceStatus(dir, { run });
}


async function browseBackup({ platform = process.platform, spawnFn = spawn, scriptPath, timeout = 300000 } = {}) {
  if (platform !== 'win32') {
    return { ok: false, error: 'not available', message: 'The file picker is only available on Windows. Type a path instead.' };
  }
  if (!scriptPath) return { ok: false, error: 'missing-script', message: 'browse-backup.ps1 was not found.' };
  const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  return new Promise((resolve) => {
    const child = spawnFn('powershell.exe', args, { windowsHide: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve({ ok: false, error: 'timeout', message: 'The file picker did not respond.' }); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const picked = String(stdout || '').trim();
      if (code === 0 && picked) resolve({ ok: true, path: picked });
      else if (code === 1 && !picked) resolve({ ok: false, cancelled: true });
      else resolve({ ok: false, error: stderr.trim() || 'picker failed', cancelled: code === 1 });
    });
  });
}

async function browseFolder({ current, platform = process.platform, spawnFn = spawn, scriptPath, timeout = 300000 } = {}) {
  if (platform !== 'win32') {
    return { ok: false, error: 'not available', message: 'The folder picker is only available on Windows. Type a path instead.' };
  }
  const ps1 = scriptPath;
  if (!ps1) return { ok: false, error: 'missing-script', message: 'browse-folder.ps1 was not found.' };
  const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1];
  if (current) args.push('-SelectedPath', String(current));
  return new Promise((resolve) => {
    const child = spawnFn('powershell.exe', args, { windowsHide: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve({ ok: false, error: 'timeout', message: 'The folder picker did not respond.' }); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const picked = String(stdout || '').trim();
      if (code === 0 && picked) resolve({ ok: true, path: picked });
      else if (code === 1 && !picked) resolve({ ok: false, cancelled: true });
      else resolve({ ok: false, error: stderr.trim() || 'picker failed', cancelled: code === 1 });
    });
  });
}


const OFFICIAL_CLAUDE_WINDOWS_DOCS = 'https://code.claude.com/docs/en/quickstart';
const OFFICIAL_CLAUDE_WINDOWS_INSTALL = 'irm https://claude.ai/install.ps1 | iex';

function prereqInstallSpec(kind, { platform = process.platform } = {}) {
  const specs = {
    claude: {
      id: 'claude',
      label: 'Install Claude CLI',
      docs: OFFICIAL_CLAUDE_WINDOWS_DOCS,
      commandText: OFFICIAL_CLAUDE_WINDOWS_INSTALL,
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', OFFICIAL_CLAUDE_WINDOWS_INSTALL],
      windowsOnly: true,
      consent: true,
    },
    git: {
      id: 'git',
      label: 'Install Git',
      commandText: 'winget install --id Git.Git -e',
      file: 'winget',
      args: ['install', '--id', 'Git.Git', '-e', '--accept-package-agreements', '--accept-source-agreements'],
      windowsOnly: true,
      consent: true,
    },
    node: {
      id: 'node',
      label: 'Install Node.js LTS',
      commandText: 'winget install --id OpenJS.NodeJS.LTS -e',
      file: 'winget',
      args: ['install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--accept-package-agreements', '--accept-source-agreements'],
      windowsOnly: true,
      consent: true,
    },
  };
  const spec = specs[kind];
  if (!spec) throw new Error('Unknown prerequisite install: ' + kind);
  const available = !spec.windowsOnly || platform === 'win32';
  return { ...spec, available, error: available ? null : 'not available' };
}

function claudeLoginSpec({ platform = process.platform, claudeCmd = 'claude' } = {}) {
  // Official login is the first interactive `claude` session (https://code.claude.com/docs/en/quickstart).
  if (platform !== 'win32') {
    return {
      available: false,
      error: 'not available',
      commandText: claudeCmd,
      file: claudeCmd,
      args: [],
      docs: OFFICIAL_CLAUDE_WINDOWS_DOCS,
    };
  }
  return {
    available: true,
    commandText: 'start "" cmd /k claude',
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'cmd.exe', '/k', claudeCmd],
    visible: true,
    docs: OFFICIAL_CLAUDE_WINDOWS_DOCS,
  };
}

function prereqCommands({ platform = process.platform, claudeCmd = 'claude' } = {}) {
  return {
    docs: OFFICIAL_CLAUDE_WINDOWS_DOCS,
    officialClaudeWindowsInstall: OFFICIAL_CLAUDE_WINDOWS_INSTALL,
    claude: prereqInstallSpec('claude', { platform }),
    git: prereqInstallSpec('git', { platform }),
    node: prereqInstallSpec('node', { platform }),
    login: claudeLoginSpec({ platform, claudeCmd }),
  };
}

async function refreshProcessPath({ platform = process.platform, run = execFileP, env = process.env } = {}) {
  if (platform !== 'win32') return env;
  const r = await run('powershell.exe', [
    '-NoProfile', '-Command',
    "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
  ], { timeout: 15000 });
  if (r.ok && r.stdout) {
    const localBin = path.join(env.USERPROFILE || env.HOME || '', '.local', 'bin');
    env.Path = r.stdout + (localBin ? ';' + localBin : '');
    env.PATH = env.Path;
  }
  return env;
}

function spawnLogged(file, args, { spawnFn = spawn, env, cwd, onData, timeout = 900000, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    const child = spawnFn(file, args, { env, cwd, windowsHide, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = timeout ? setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeout) : null;
    const emit = (s) => { if (onData && s) onData(s); };
    child.stdout.on('data', (d) => { const s = String(d); stdout += s; emit(s); });
    child.stderr.on('data', (d) => { const s = String(d); stderr += s; emit(s); });
    child.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ ok: false, code: 1, stdout, stderr, error: err.message }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ ok: code === 0, code, stdout, stderr }); });
  });
}

async function runPrereqInstall(kind, { platform = process.platform, spawnFn = spawn, env = process.env, onData, timeout } = {}) {
  const spec = prereqInstallSpec(kind, { platform });
  if (!spec.available) return { ok: false, error: spec.error, spec };
  const result = await spawnLogged(spec.file, spec.args, { spawnFn, env, onData, timeout, windowsHide: true });
  await refreshProcessPath({ platform, env });
  return { ...result, spec };
}

function launchClaudeLogin({ platform = process.platform, spawnFn = spawn, env = process.env, claudeCmd } = {}) {
  const cmd = claudeCmd || env.CLAUDE_PATH || 'claude';
  const spec = claudeLoginSpec({ platform, claudeCmd: cmd });
  if (!spec.available) return { ok: false, error: spec.error, spec };
  const child = spawnFn(spec.file, spec.args, { env, detached: true, stdio: 'ignore', windowsHide: false });
  if (child.unref) child.unref();
  return { ok: true, spec, pid: child.pid };
}

module.exports = {
  PRESETS, DEFAULT_SOURCE, MANIFEST_NAME, MODEL_CHOICES, EFFORT_CHOICES, PERMISSION_MODES,
  execFileP, defaultInstallDir, normalizeInstallDir, specialFolders, isInside, isDownloadsOrTemp, looksLikeZipExtract,
  isGitUrl, resolveSource, listBranches, branchExists, checkWritable, checkFolder, normalizeGitUrl,
  checkPrereqs, detectInstall, readManifest, writeManifest, writeConfig, install, sourceStatus, switchSource,
  browseFolder, browseBackup,
  OFFICIAL_CLAUDE_WINDOWS_DOCS, OFFICIAL_CLAUDE_WINDOWS_INSTALL,
  prereqInstallSpec, claudeLoginSpec, prereqCommands, refreshProcessPath, spawnLogged, runPrereqInstall, launchClaudeLogin,
};
