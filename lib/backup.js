'use strict';
// Backup and restore of Crew user data. Never writes .env or secrets.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isInside, normalizeInstallDir, defaultInstallDir } = require('./setup');
const { createZip, readZip, extractEntry } = require('./zip');

const BACKUP_NAME_RE = /^ClaudeCrew-backup-.*\.zip$/i;
const MANIFEST_NAME = 'manifest.json';
const MANIFEST_VERSION = 1;
const MAX_FILES = 20000;
const MAX_UNCOMPRESSED = 512 * 1024 * 1024;
const MAX_ENTRY = 128 * 1024 * 1024;
const MAX_PATH = 400;

const SECRET_RE = [
  /(?:^|\/)\.env$/i,
  /(?:^|\/)\.env\.[^/]+$/i,
  /(?:^|\/)secrets(?:\/|$)/i,
  /(?:^|\/)vapid\.json$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(?:^|\/)(id_rsa|id_ed25519|credentials(?:\.json)?)(?:$)/i,
];

const KNOWN_CONFIG_KEYS = {
  root: ['settings', 'cloudflare', 'agents'],
  settings: [
    'port', 'allowLan', 'userName', 'defaultAgent', 'maxHops', 'maxConcurrent',
    'permissionMode', 'model', 'claudePath', 'budget', 'effort', 'machineName',
  ],
  budget: ['enabled', 'fiveHour', 'weekly'],
  cloudflare: ['enabled', 'hostname', 'teamDomain', 'aud', 'port', 'allowedEmails'],
  agent: ['id', 'name', 'emoji', 'avatar', 'cwd', 'description', 'model', 'effort', 'permissionMode', 'color', 'group'],
};

const USER_DATA_TOP = ['data', 'crew.config.json', 'workspace', 'install-log.txt', 'summaries'];

function isSecretRel(rel) {
  const n = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return SECRET_RE.some((re) => re.test(n));
}

function backupZipName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + '-' + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds());
  return 'ClaudeCrew-backup-' + stamp + '.zip';
}

function defaultBackupPath({ env = process.env, homedir = os.homedir(), now = new Date() } = {}) {
  return path.join(env.USERPROFILE || env.HOME || homedir, backupZipName(now));
}

function findBackupZips({
  env = process.env,
  homedir = os.homedir(),
  exists = fs.existsSync,
  readdir = (p) => fs.readdirSync(p),
  stat = (p) => fs.statSync(p),
  extra = [],
} = {}) {
  const home = env.USERPROFILE || env.HOME || homedir;
  const found = [];
  if (exists(home)) {
    let names = [];
    try { names = readdir(home); } catch { names = []; }
    for (const name of names) {
      if (!BACKUP_NAME_RE.test(name)) continue;
      const p = path.join(home, name);
      try {
        const st = stat(p);
        if (st.isFile()) found.push({ path: p, name, mtime: st.mtimeMs, size: st.size });
      } catch { /* skip */ }
    }
  }
  for (const e of extra || []) {
    if (!e || !exists(e)) continue;
    try {
      const st = stat(e);
      if (st.isFile()) found.push({ path: path.resolve(e), name: path.basename(e), mtime: st.mtimeMs, size: st.size });
    } catch { /* skip */ }
  }
  found.sort((a, b) => b.mtime - a.mtime || String(b.name).localeCompare(String(a.name)));
  const seen = new Set();
  return found.filter((f) => { if (seen.has(f.path)) return false; seen.add(f.path); return true; });
}

function walkFiles(root, { exists = fs.existsSync, stat = (p) => fs.statSync(p), readdir = (p, o) => fs.readdirSync(p, o) } = {}) {
  const out = [];
  const skipped = [];
  function walk(abs, rel) {
    let st;
    try { st = stat(abs); } catch (err) { skipped.push({ rel, reason: err.message }); return; }
    if (st.isSymbolicLink && st.isSymbolicLink()) {
      skipped.push({ rel, reason: 'symlink skipped' });
      return;
    }
    if (st.isFile()) {
      out.push({ rel, path: abs, size: st.size });
      return;
    }
    if (!st.isDirectory()) {
      skipped.push({ rel, reason: 'not a regular file' });
      return;
    }
    let names = [];
    try { names = readdir(abs, { withFileTypes: false }); } catch (err) { skipped.push({ rel, reason: err.message }); return; }
    for (const name of names) {
      walk(path.join(abs, name), rel ? rel + '/' + name : name);
    }
  }
  if (exists(root)) walk(root, '');
  return { files: out, skipped };
}

function classifyRel(rel) {
  const n = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (n === 'crew.config.json' || /(^|\/)crew\.config\.json$/.test(n)) return 'crew.config.json';
  if (n === 'summaries' || n.startsWith('summaries/') || /(^|\/)data\/summaries(\/|$)/.test(n)) return 'summaries';
  if (n === 'data' || n.startsWith('data/')) return 'data/';
  if (n === 'workspace' || n.startsWith('workspace/')) return 'workspace';
  if (n === 'install-log.txt' || /(^|\/)install-log\.txt$/.test(n)) return 'install-log.txt';
  if (n === MANIFEST_NAME) return 'manifest';
  return 'other';
}

function collectUserDataFiles(userData, { exists = fs.existsSync, stat, readdir } = {}) {
  const files = [];
  const skipped = [];
  const missing = [];
  const seen = new Set();
  for (const it of userData || []) {
    const src = it.path;
    const arcBase = String(it.arc || it.rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!exists(src)) {
      missing.push({ rel: arcBase, path: src, reason: 'missing' });
      continue;
    }
    let st;
    try { st = (stat || fs.statSync)(src); } catch (err) {
      skipped.push({ rel: arcBase, reason: err.message });
      continue;
    }
    if (st.isFile()) {
      if (isSecretRel(arcBase)) { skipped.push({ rel: arcBase, reason: 'secret' }); continue; }
      if (!seen.has(arcBase)) { files.push({ rel: arcBase, path: src, size: st.size }); seen.add(arcBase); }
      continue;
    }
    const walked = walkFiles(src, { exists, stat: stat || fs.statSync, readdir: readdir || fs.readdirSync });
    for (const s of walked.skipped) skipped.push({ rel: arcBase ? arcBase + '/' + s.rel : s.rel, reason: s.reason });
    for (const f of walked.files) {
      const rel = arcBase ? arcBase + (f.rel ? '/' + f.rel : '') : f.rel;
      if (isSecretRel(rel)) { skipped.push({ rel, reason: 'secret' }); continue; }
      if (seen.has(rel)) continue;
      seen.add(rel);
      files.push({ rel, path: f.path, size: f.size });
    }
  }
  return { files, skipped, missing };
}

function prefixForRoots(userData) {
  const used = new Set();
  const prefixFor = new Map();
  const roots = [...new Set((userData || []).map((u) => u.installDir || u.root).filter(Boolean))];
  const multi = roots.length > 1;
  for (const it of userData || []) {
    const root = it.installDir || it.root;
    if (!root || prefixFor.has(root)) continue;
    if (!multi) { prefixFor.set(root, ''); continue; }
    const base = path.basename(root) || 'install';
    let prefix = base;
    let n = 2;
    while (used.has(prefix)) { prefix = base + '-' + n; n++; }
    used.add(prefix);
    prefixFor.set(root, prefix);
  }
  return prefixFor;
}

async function writeBackup({
  userData,
  dest,
  now = new Date(),
  exists = fs.existsSync,
  stat = (p) => fs.statSync(p),
  readdir = (p, o) => fs.readdirSync(p, o),
  readFile = fs.readFileSync,
  log = () => {},
} = {}) {
  if (!dest) throw new Error('Backup path is missing.');
  const prefixFor = prefixForRoots(userData);
  const items = [];
  const sources = [];
  for (const it of userData || []) {
    const root = it.installDir || it.root;
    const prefix = (root && prefixFor.get(root)) || '';
    const rel = prefix ? prefix + '/' + String(it.rel).replace(/\\/g, '/') : String(it.rel).replace(/\\/g, '/');
    items.push({ ...it, arc: rel });
    if (root && !sources.includes(root)) sources.push(root);
  }
  const collected = collectUserDataFiles(items, { exists, stat, readdir });
  const manifest = {
    version: MANIFEST_VERSION,
    kind: 'claude-crew-backup',
    date: now.toISOString(),
    sourceDirs: sources,
    fileCount: collected.files.length,
    skippedCount: collected.skipped.length,
    missingCount: collected.missing.length,
    bytes: collected.files.reduce((n, f) => n + (f.size || 0), 0),
  };
  const zipEntries = [];
  for (const f of collected.files) {
    zipEntries.push({ name: f.rel, data: readFile(f.path) });
  }
  zipEntries.push({ name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  const zip = createZip(dest, zipEntries, { now });
  const counts = {
    files: collected.files.length,
    bytes: manifest.bytes,
    zipBytes: zip.size,
    skipped: collected.skipped.length,
    missing: collected.missing.length,
    kinds: tallyKinds(collected.files.map((f) => f.rel)),
  };
  log('Backup wrote ' + counts.files + ' files (' + counts.bytes + ' bytes) to ' + dest
    + (counts.skipped || counts.missing ? '; skipped ' + counts.skipped + ', missing ' + counts.missing : ''));
  for (const s of collected.skipped) log('  skipped: ' + s.rel + ' (' + s.reason + ')');
  for (const m of collected.missing) log('  missing: ' + m.rel);
  return {
    ok: true,
    path: dest,
    manifest,
    counts,
    skipped: collected.skipped,
    missing: collected.missing,
    files: collected.files.map((f) => f.rel),
  };
}

function tallyKinds(rels) {
  const kinds = { 'data/': 0, summaries: 0, workspace: 0, 'crew.config.json': 0, 'install-log.txt': 0, other: 0, manifest: 0 };
  for (const rel of rels) {
    const k = classifyRel(rel);
    kinds[k] = (kinds[k] || 0) + 1;
  }
  return kinds;
}

function unsafeZipPath(name) {
  const raw = String(name || '');
  if (!raw) return 'empty name';
  if (raw.length > MAX_PATH) return 'path too long';
  if (raw.includes('\0')) return 'nul in path';
  const n = raw.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(raw) || /^[A-Za-z]:/.test(n)) return 'drive letter';
  if (n.startsWith('/') || n.startsWith('//') || raw.startsWith('\\\\') || n.startsWith('\\\\')) return 'absolute or UNC path';
  const parts = n.split('/');
  if (parts.some((p) => p === '..')) return 'path traversal (..)';
  return null;
}

function inferLayout(entries) {
  const names = entries.map((e) => e.name.replace(/\\/g, '/')).filter((n) => n && n !== MANIFEST_NAME);
  const hasRoot = (p) => names.some((n) => n === p || n.startsWith(p + '/'));
  if (hasRoot('crew.config.json') || hasRoot('data') || hasRoot('workspace') || hasRoot('summaries') || hasRoot('install-log.txt')) {
    return { kind: 'single', prefix: '' };
  }
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const prefixes = [...tops].filter((t) => names.some((n) => n === t + '/crew.config.json' || n.startsWith(t + '/data/') || n === t + '/data' || n.startsWith(t + '/workspace/')));
  if (prefixes.length) return { kind: 'multi', prefix: prefixes.length === 1 ? prefixes[0] + '/' : '', prefixes };
  return { kind: 'unknown', prefix: '' };
}

function inspectBackup(file, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  if (!exists(file)) throw new Error('Backup file not found: ' + file);
  let zip;
  try { zip = readZip(file); } catch (err) { throw new Error(err.message || 'Not a valid ZIP file.'); }
  const warnings = [];
  const secrets = [];
  const unsafe = [];
  let uncompressed = 0;
  if (zip.entries.length > MAX_FILES) throw new Error('Backup has too many entries (' + zip.entries.length + ').');
  for (const e of zip.entries) {
    const bad = unsafeZipPath(e.name);
    if (bad) unsafe.push({ name: e.name, reason: bad });
    if (e.isSymlink) unsafe.push({ name: e.name, reason: 'symlink' });
    if (e.size > MAX_ENTRY) unsafe.push({ name: e.name, reason: 'entry too large' });
    uncompressed += e.size || 0;
    if (isSecretRel(e.name)) secrets.push(e.name);
  }
  if (uncompressed > MAX_UNCOMPRESSED) throw new Error('Backup is too large uncompressed (' + uncompressed + ' bytes).');
  if (unsafe.length) {
    const err = new Error('Backup failed safety checks: ' + unsafe.map((u) => u.name + ' (' + u.reason + ')').join('; '));
    err.unsafe = unsafe;
    throw err;
  }
  let manifest = null;
  const manEnt = zip.entries.find((e) => e.name.replace(/\\/g, '/') === MANIFEST_NAME && !e.isDir);
  if (manEnt) {
    try { manifest = JSON.parse(extractEntry(zip, manEnt).toString('utf8')); } catch {
      warnings.push('manifest.json is present but could not be parsed; inferring layout.');
    }
  }
  const layout = inferLayout(zip.entries);
  if (!manifest) warnings.push('Older backup without a manifest; layout inferred as ' + layout.kind + '.');
  const visible = zip.entries.filter((e) => !e.isDir && e.name.replace(/\\/g, '/') !== MANIFEST_NAME);
  const items = visible.map((e) => ({
    name: e.name.replace(/\\/g, '/'),
    size: e.size,
    kind: classifyRel(stripPrefix(e.name.replace(/\\/g, '/'), layout)),
    secret: isSecretRel(e.name),
  }));
  return {
    ok: true,
    path: file,
    size: zip.size,
    manifest,
    layout,
    warnings,
    secrets,
    items,
    counts: {
      files: items.length,
      bytes: items.reduce((n, i) => n + (i.size || 0), 0),
      secrets: secrets.length,
      kinds: tallyKinds(items.filter((i) => !i.secret).map((i) => i.name)),
    },
    _zip: zip,
  };
}

function stripPrefix(name, layout) {
  if (layout && layout.kind === 'multi' && layout.prefix && name.startsWith(layout.prefix)) return name.slice(layout.prefix.length);
  if (layout && layout.kind === 'multi' && !layout.prefix) {
    const i = name.indexOf('/');
    return i >= 0 ? name.slice(i + 1) : name;
  }
  return name;
}

function knownConfigWarnings(cfg) {
  const warnings = [];
  if (!cfg || typeof cfg !== 'object') return ['crew.config.json is not an object'];
  for (const k of Object.keys(cfg)) {
    if (!KNOWN_CONFIG_KEYS.root.includes(k)) warnings.push('Unknown config key: ' + k);
  }
  const settings = cfg.settings || {};
  if (settings && typeof settings === 'object') {
    for (const k of Object.keys(settings)) {
      if (!KNOWN_CONFIG_KEYS.settings.includes(k)) warnings.push('Unknown settings key: ' + k);
      if (k === 'budget' && settings.budget && typeof settings.budget === 'object') {
        for (const bk of Object.keys(settings.budget)) {
          if (!KNOWN_CONFIG_KEYS.budget.includes(bk)) warnings.push('Unknown budget key: ' + bk);
        }
      }
    }
  }
  if (Array.isArray(cfg.agents)) {
    cfg.agents.forEach((a, i) => {
      if (!a || typeof a !== 'object') return;
      for (const k of Object.keys(a)) {
        if (!KNOWN_CONFIG_KEYS.agent.includes(k)) warnings.push('Unknown agent key on agent[' + i + ']: ' + k);
      }
    });
  }
  return warnings;
}

function migrateConfig(raw, { warnings = [] } = {}) {
  if (!raw || typeof raw !== 'object') return { config: raw, warnings };
  const out = {};
  for (const k of KNOWN_CONFIG_KEYS.root) if (raw[k] !== undefined) out[k] = raw[k];
  if (out.settings && typeof out.settings === 'object') {
    const s = {};
    for (const k of KNOWN_CONFIG_KEYS.settings) if (out.settings[k] !== undefined) s[k] = out.settings[k];
    if (s.budget && typeof s.budget === 'object') {
      const b = {};
      for (const k of KNOWN_CONFIG_KEYS.budget) if (s.budget[k] !== undefined) b[k] = s.budget[k];
      s.budget = b;
    }
    out.settings = s;
  }
  warnings.push(...knownConfigWarnings(raw));
  return { config: out, warnings };
}

function previewRestore(file, destDir, {
  selected,
  exists = fs.existsSync,
  readFile = fs.readFileSync,
  stat = (p) => fs.statSync(p),
} = {}) {
  const dest = normalizeInstallDir(destDir);
  if (!dest) throw new Error('Restore target folder is missing.');
  const info = inspectBackup(file, { exists, readFile });
  const skippedSecrets = [];
  const planned = [];
  const want = selected && selected.length ? new Set(selected.map((s) => String(s).replace(/\\/g, '/'))) : null;
  for (const item of info.items) {
    if (item.secret) { skippedSecrets.push(item.name); continue; }
    if (want && !want.has(item.name) && !want.has(stripPrefix(item.name, info.layout))) continue;
    const rel = stripPrefix(item.name, info.layout);
    if (!rel || rel === MANIFEST_NAME) continue;
    const bad = unsafeZipPath(rel);
    if (bad) throw new Error('Refusing to restore unsafe path: ' + rel + ' (' + bad + ')');
    const target = path.resolve(dest, rel);
    if (!isInside(target, dest) && target !== dest) throw new Error('Restore path escapes the install folder: ' + rel);
    const existsTarget = exists(target);
    planned.push({
      name: item.name,
      rel,
      size: item.size,
      kind: item.kind,
      target,
      exists: existsTarget,
    });
  }
  const conflicts = planned.filter((p) => p.exists);
  const configWarnings = [];
  const cfgItem = planned.find((p) => p.rel === 'crew.config.json' || p.kind === 'crew.config.json');
  if (cfgItem) {
    const ent = info._zip.entries.find((e) => e.name.replace(/\\/g, '/') === cfgItem.name);
    if (ent) {
      try {
        const parsed = JSON.parse(extractEntry(info._zip, ent).toString('utf8'));
        const mig = migrateConfig(parsed);
        configWarnings.push(...mig.warnings);
      } catch { configWarnings.push('crew.config.json could not be parsed.'); }
    }
  }
  return {
    ok: true,
    path: file,
    dest,
    manifest: info.manifest,
    layout: { kind: info.layout.kind, prefix: info.layout.prefix, prefixes: info.layout.prefixes },
    warnings: [...info.warnings, ...configWarnings],
    secretsSkipped: skippedSecrets,
    planned,
    conflicts,
    counts: {
      restore: planned.length,
      conflicts: conflicts.length,
      secrets: skippedSecrets.length,
      kinds: tallyKinds(planned.map((p) => p.rel)),
    },
  };
}

async function restoreBackup({
  file,
  destDir,
  mode, // 'merge' | 'replace'
  selected,
  confirmReplace = false,
  env = process.env,
  homedir = os.homedir(),
  now = new Date(),
  exists = fs.existsSync,
  readFile = fs.readFileSync,
  writeFile = fs.writeFileSync,
  mkdir = (p, o) => fs.mkdirSync(p, o),
  log = () => {},
} = {}) {
  if (mode === 'cancel' || !mode) {
    return { ok: false, cancelled: true };
  }
  const preview = previewRestore(file, destDir, { selected, exists, readFile });
  if (preview.conflicts.length && mode === 'replace' && !confirmReplace) {
    return { ok: false, needsConfirm: true, preview };
  }
  if (preview.conflicts.length && mode !== 'merge' && mode !== 'replace') {
    return { ok: false, needsConfirm: true, preview };
  }
  const dest = preview.dest;
  mkdir(dest, { recursive: true });
  let safetyBackup = null;
  if (mode === 'replace' && preview.conflicts.length) {
    const safetyPath = path.join(env.USERPROFILE || env.HOME || homedir, 'ClaudeCrew-pre-restore-' + backupZipName(now).replace(/^ClaudeCrew-backup-/, ''));
    const conflictData = preview.conflicts.filter((c) => exists(c.target)).map((c) => ({
      rel: c.rel,
      path: c.target,
      arc: c.rel,
    }));
    if (conflictData.length) {
      safetyBackup = await writeBackup({
        userData: conflictData.map((c) => ({ rel: c.rel, path: c.path, installDir: dest })),
        dest: safetyPath,
        now, exists, log,
      });
      log('Current files backed up to ' + safetyPath + ' before replace.');
    }
  }
  const info = inspectBackup(file, { exists, readFile });
  const restored = [];
  const skipped = preview.secretsSkipped.map((n) => ({ rel: n, reason: 'secret' }));
  for (const plan of preview.planned) {
    if (mode === 'merge' && plan.exists) {
      skipped.push({ rel: plan.rel, reason: 'kept existing' });
      continue;
    }
    const ent = info._zip.entries.find((e) => e.name.replace(/\\/g, '/') === plan.name);
    if (!ent) { skipped.push({ rel: plan.rel, reason: 'missing in zip' }); continue; }
    let data = extractEntry(info._zip, ent);
    if (plan.rel === 'crew.config.json' || plan.kind === 'crew.config.json') {
      try {
        const mig = migrateConfig(JSON.parse(data.toString('utf8')));
        data = Buffer.from(JSON.stringify(mig.config, null, 2), 'utf8');
      } catch { /* write as-is if parse fails; already warned */ }
    }
    mkdir(path.dirname(plan.target), { recursive: true });
    writeFile(plan.target, data);
    restored.push({ rel: plan.rel, path: plan.target, bytes: data.length });
  }
  const counts = {
    restored: restored.length,
    skipped: skipped.length,
    secrets: preview.secretsSkipped.length,
    conflicts: preview.conflicts.length,
    kinds: tallyKinds(restored.map((r) => r.rel)),
  };
  log('Restored ' + counts.restored + ' files into ' + dest + '; skipped ' + counts.skipped + ' (secrets: ' + counts.secrets + ').');
  return {
    ok: true,
    dest,
    mode,
    preview,
    safetyBackup,
    restored,
    skipped,
    secretsSkipped: preview.secretsSkipped,
    warnings: preview.warnings,
    counts,
  };
}


function dataFilesInUserData(userData, hooks = {}) {
  const collected = collectUserDataFiles(userData, hooks);
  return collected.files.filter((f) => {
    const rel = String(f.rel || '').replace(/\\/g, '/');
    return rel === 'data' || rel.startsWith('data/');
  });
}

// Confirm a backup zip opens, its manifest counts match, and it is not empty when data/ has files.
function verifyBackup(dest, {
  userData,
  exists = fs.existsSync,
  stat = (p) => fs.statSync(p),
  readdir,
  readFile = fs.readFileSync,
} = {}) {
  if (!dest) return { ok: false, error: 'Backup path is missing. Uninstall will not continue.' };
  if (!exists(dest)) return { ok: false, error: 'Backup zip was not created at ' + dest + '. Uninstall will not continue.' };
  let st;
  try { st = stat(dest); } catch (err) {
    return { ok: false, error: 'Backup zip could not be read at ' + dest + ': ' + err.message + ' Uninstall will not continue.' };
  }
  if (!st.size) return { ok: false, error: 'Backup zip at ' + dest + ' is empty. Uninstall will not continue.' };
  let info;
  try { info = inspectBackup(dest, { exists, readFile }); } catch (err) {
    return { ok: false, error: 'Backup zip could not be opened: ' + (err.message || err) + ' Uninstall will not continue.' };
  }
  const fileCount = (info.items || []).length;
  if (info.manifest && typeof info.manifest.fileCount === 'number' && info.manifest.fileCount !== fileCount) {
    return {
      ok: false,
      error: 'Backup manifest says ' + info.manifest.fileCount + ' files but the zip has ' + fileCount + '. Uninstall will not continue.',
      info,
    };
  }
  if (userData && userData.length) {
    const sourceData = dataFilesInUserData(userData, { exists, stat, readdir });
    if (sourceData.length && fileCount === 0) {
      return { ok: false, error: 'Backup is empty but data/ has ' + sourceData.length + ' file(s). Uninstall will not continue.', info };
    }
    if (sourceData.length) {
      const zipData = (info.items || []).filter((i) => {
        const n = stripPrefix(String(i.name || '').replace(/\\/g, '/'), info.layout);
        return n === 'data' || n.startsWith('data/');
      });
      if (!zipData.length) {
        return { ok: false, error: 'Backup is missing data/ files (source has ' + sourceData.length + '). Uninstall will not continue.', info };
      }
    }
  }
  return { ok: true, info, fileCount, path: dest };
}

function assertBackupOrThrow(result) {
  if (!result || !result.ok) throw new Error((result && result.error) || 'Backup failed. Uninstall will not continue.');
  return result;
}

module.exports = {
  BACKUP_NAME_RE, MANIFEST_NAME, MANIFEST_VERSION,
  MAX_FILES, MAX_UNCOMPRESSED, MAX_ENTRY,
  isSecretRel, backupZipName, defaultBackupPath, findBackupZips,
  collectUserDataFiles, writeBackup, inspectBackup, inferLayout,
  previewRestore, restoreBackup, migrateConfig, knownConfigWarnings,
  classifyRel, unsafeZipPath, USER_DATA_TOP, tallyKinds,
  dataFilesInUserData, verifyBackup, assertBackupOrThrow,
};
