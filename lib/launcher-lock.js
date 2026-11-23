'use strict';
// Single-instance lock for run-crew.cmd. A lock file records the launcher PID.
// Never kills a process; the caller exits if another live launcher already holds the lock.
const fs = require('fs');
const path = require('path');

const LOCK_REL = path.join('data', 'crew.launcher.lock');

function lockPath(installDir) {
  return path.join(path.resolve(installDir || process.cwd()), LOCK_REL);
}

function alreadyRunningMessage(pid, dir) {
  return 'Crew launcher already running for this install (PID ' + pid + '), not starting another copy';
}

function readLock(installDir, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  const file = lockPath(installDir);
  if (!exists(file)) return null;
  try {
    const raw = readFile(file, 'utf8');
    const rec = JSON.parse(raw);
    if (!rec || !Number(rec.pid)) return null;
    return { ...rec, pid: Number(rec.pid), path: file };
  } catch { return null; }
}

function isPidAlive(pid, { killFn = (p, s) => process.kill(p, s) } = {}) {
  const n = Number(pid);
  if (!n) return false;
  try { killFn(n, 0); return true; } catch (err) {
    return !(err && (err.code === 'ESRCH' || err.code === 'EINVAL'));
  }
}

function commandLooksLikeLauncher(cmdline, installDir) {
  const line = String(cmdline || '');
  if (!/run-crew\.cmd/i.test(line)) return false;
  if (!installDir) return true;
  const root = path.resolve(installDir).replace(/\\/g, '/').toLowerCase();
  const norm = line.replace(/\\/g, '/').toLowerCase();
  return !root || norm.includes(root);
}

async function isLockLive(lock, {
  installDir,
  killFn,
  cmdForPid,
} = {}) {
  if (!lock || !lock.pid) return false;
  if (!isPidAlive(lock.pid, { killFn })) return false;
  if (typeof cmdForPid === 'function') {
    try {
      const cmd = await cmdForPid(lock.pid);
      if (cmd && !commandLooksLikeLauncher(cmd, installDir || lock.dir)) return false;
    } catch { /* if we cannot read the command line, a live PID is enough */ }
  }
  return true;
}

async function acquireLauncherLock(installDir, {
  pid,
  dir,
  now = new Date(),
  mkdir = fs.mkdirSync,
  writeFile = fs.writeFileSync,
  unlink = fs.unlinkSync,
  exists = fs.existsSync,
  readFile = fs.readFileSync,
  killFn,
  cmdForPid,
} = {}) {
  const root = path.resolve(installDir || dir || process.cwd());
  const file = lockPath(root);
  const holder = Number(pid) || 0;
  if (!holder) return { ok: false, error: 'Launcher lock needs a PID.' };
  mkdir(path.dirname(file), { recursive: true });

  const rec = { pid: holder, dir: root, created: now.toISOString() };
  const body = JSON.stringify(rec, null, 2);

  const take = (flag) => {
    writeFile(file, body, { flag: flag || 'wx', encoding: 'utf8' });
    return { ok: true, path: file, pid: holder, created: true };
  };

  try {
    return take('wx');
  } catch (err) {
    if (!err || err.code !== 'EEXIST') return { ok: false, error: err.message };
    const existing = readLock(root, { readFile, exists });
    if (existing && existing.pid === holder) return { ok: true, path: file, pid: holder, existing: true };
    if (existing && await isLockLive(existing, { installDir: root, killFn, cmdForPid })) {
      return {
        ok: false,
        alreadyRunning: true,
        pid: existing.pid,
        path: file,
        message: alreadyRunningMessage(existing.pid, root),
      };
    }
    try { if (exists(file)) unlink(file); } catch { /* retry below */ }
    try {
      return take('wx');
    } catch (err2) {
      if (err2 && err2.code === 'EEXIST') {
        const again = readLock(root, { readFile, exists });
        if (again && await isLockLive(again, { installDir: root, killFn, cmdForPid })) {
          return {
            ok: false,
            alreadyRunning: true,
            pid: again.pid,
            path: file,
            message: alreadyRunningMessage(again.pid, root),
          };
        }
      }
      // Last resort: overwrite a stale lock we failed to replace exclusively.
      try {
        writeFile(file, body, { encoding: 'utf8' });
        return { ok: true, path: file, pid: holder, created: true, replaced: true };
      } catch (err3) {
        return { ok: false, error: err3.message };
      }
    }
  }
}

function releaseLauncherLock(installDir, {
  pid,
  exists = fs.existsSync,
  readFile = fs.readFileSync,
  unlink = fs.unlinkSync,
} = {}) {
  const rec = readLock(installDir, { readFile, exists });
  if (!rec) return { ok: true, missing: true };
  if (pid && rec.pid !== Number(pid)) return { ok: false, reason: 'not-holder', pid: rec.pid };
  try { unlink(rec.path); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, released: true, path: rec.path };
}

module.exports = {
  LOCK_REL, lockPath, alreadyRunningMessage, readLock, isPidAlive,
  commandLooksLikeLauncher, isLockLive, acquireLauncherLock, releaseLauncherLock,
};
