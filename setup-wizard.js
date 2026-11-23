'use strict';
// Local setup / uninstall wizard. Bind to 127.0.0.1 only. No secrets.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const setup = require('./lib/setup');
const uninstall = require('./lib/uninstall');
const scan = require('./lib/scan');
const backup = require('./lib/backup');

const ROOT = __dirname;
const args = process.argv.slice(2);
const flag = (name) => args.includes('--' + name);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const START_DIR = setup.normalizeInstallDir(opt('dir', ROOT));
function dirArg(value) { return setup.normalizeInstallDir(value || START_DIR); }

async function listBackups(extra) {
  return { ok: true, backups: backup.findBackupZips({ extra: extra || [] }) };
}


const WANT_UNINSTALL = flag('uninstall');
const WANT_SCAN = flag('scan');
const DRY_RUN = flag('dry-run');
const PLAN_PATH = opt('plan', '');
const NO_OPEN = flag('no-open');
const PORT_START = Number(opt('port', process.env.CREW_SETUP_PORT || 17777));

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function defaults() {
  return {
    dir: START_DIR,
    installDir: setup.defaultInstallDir(),
    presets: setup.PRESETS,
    defaultSource: setup.DEFAULT_SOURCE,
    defaultBranch: setup.PRESETS[setup.DEFAULT_SOURCE].defaultBranch,
    models: setup.MODEL_CHOICES,
    efforts: setup.EFFORT_CHOICES,
    permissionModes: setup.PERMISSION_MODES,
    detect: setup.detectInstall(START_DIR),
    userName: process.env.USERNAME || process.env.USER || os.userInfo().username || 'You',
    machineName: os.hostname(),
    browse: process.platform === 'win32' ? 'available' : 'not available',
    uninstall: WANT_UNINSTALL,
  };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/setup.html')) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'setup.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/defaults') return send(res, 200, defaults());
    if (req.method === 'GET' && url.pathname === '/api/prereqs') return send(res, 200, await setup.checkPrereqs());
    if (req.method === 'GET' && url.pathname === '/api/backups') {
      return send(res, 200, await listBackups((url.searchParams.get('extra') || '').split(',').filter(Boolean)));
    }
    if (req.method === 'GET' && url.pathname === '/api/uninstall/scan') {
      const result = await scan.scanCrew({
        currentDir: url.searchParams.get('dir') || START_DIR,
        extraDirs: [START_DIR],
        scriptPath: path.join(ROOT, 'scan-inventory.ps1'),
      });
      return send(res, 200, result);
    }
    if (req.method === 'GET' && url.pathname === '/api/branches') {
      const list = await setup.listBranches(url.searchParams.get('url') || '');
      return send(res, 200, { branches: list });
    }
    if (req.method === 'GET' && url.pathname === '/api/detect') {
      const dir = url.searchParams.get('dir') || START_DIR;
      return send(res, 200, setup.detectInstall(dir));
    }
    if (req.method === 'GET' && url.pathname === '/api/source') {
      const dir = url.searchParams.get('dir') || START_DIR;
      return send(res, 200, await setup.sourceStatus(dir));
    }
    if (req.method === 'GET' && url.pathname === '/api/uninstall/preview') {
      const dir = url.searchParams.get('dir') || START_DIR;
      const dataMode = url.searchParams.get('dataMode') || 'backup';
      return send(res, 200, uninstall.previewUninstall(dir, { dataMode }));
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    const body = JSON.parse((await readBody(req)) || '{}');

    if (url.pathname === '/api/backups/inspect') {
      try { return send(res, 200, backup.inspectBackup(body.path)); }
      catch (err) { return send(res, 400, { ok: false, error: err.message, unsafe: err.unsafe }); }
    }
    if (url.pathname === '/api/backups/preview') {
      try { return send(res, 200, backup.previewRestore(body.path, dirArg(body.dir), { selected: body.selected })); }
      catch (err) { return send(res, 400, { ok: false, error: err.message }); }
    }
    if (url.pathname === '/api/backups/restore') {
      try {
        const result = await backup.restoreBackup({
          file: body.path,
          destDir: dirArg(body.dir),
          mode: body.mode,
          selected: body.selected,
          confirmReplace: !!body.confirmReplace,
        });
        return send(res, result.ok || result.needsConfirm || result.cancelled ? 200 : 400, result);
      } catch (err) { return send(res, 400, { ok: false, error: err.message }); }
    }
    if (url.pathname === '/api/browse-backup') {
      const result = await setup.browseBackup({ scriptPath: path.join(ROOT, 'browse-backup.ps1') });
      return send(res, result.ok ? 200 : (result.error === 'not available' ? 501 : 200), result);
    }
    if (url.pathname === '/api/uninstall/retry-stop') {
      try {
        const actions = await uninstall.stopSelectedProcesses(body.processes || [], {
          platform: process.platform, selfPid: process.pid, selfPpid: process.ppid,
        });
        let stillRunning = [];
        try {
          const next = await scan.scanCrew({ currentDir: START_DIR, extraDirs: [START_DIR], scriptPath: path.join(ROOT, 'scan-inventory.ps1') });
          stillRunning = uninstall.stillRunningFromScan(next, { excludedPids: uninstall.excludedUninstallPids(next.groups && next.groups.processes || [], { selfPid: process.pid, selfPpid: process.ppid }) });
        } catch { /* best-effort */ }
        return send(res, 200, { ok: true, actions, stillRunning });
      } catch (err) { return send(res, 400, { ok: false, error: err.message }); }
    }


    if (url.pathname === '/api/prereqs/install') {
      const kind = body.kind;
      let spec;
      try { spec = setup.prereqInstallSpec(kind); } catch (err) { return send(res, 400, { error: err.message }); }
      if (!spec.available) return send(res, 501, { ok: false, error: spec.error, spec });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      const log = (line) => res.write(JSON.stringify({ line }) + '\n');
      log('Running: ' + spec.commandText);
      if (spec.docs) log('Source: ' + spec.docs);
      try {
        const result = await setup.runPrereqInstall(kind, { onData: (s) => log(s.replace(/\r/g, '')) });
        await setup.refreshProcessPath();
        const prereqs = await setup.checkPrereqs();
        res.write(JSON.stringify({ ok: result.ok, code: result.code, error: result.error, prereqs, spec }) + '\n');
      } catch (err) {
        res.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
      }
      return res.end();
    }
    if (url.pathname === '/api/prereqs/login' || url.pathname === '/api/claude-login') {
      const launched = setup.launchClaudeLogin();
      return send(res, launched.ok ? 200 : 501, launched);
    }
    if (url.pathname === '/api/prereqs/fix-path') {
      const pathFix = await setup.ensureLocalClaudePath();
      const prereqs = await setup.checkPrereqs();
      return send(res, pathFix.failed ? 500 : 200, { ok: !pathFix.failed, pathFix, prereqs });
    }
    if (url.pathname === '/api/uninstall/preview') {
      try {
        const scanResult = body.scan || await scan.scanCrew({ currentDir: body.dir || START_DIR, extraDirs: [START_DIR], scriptPath: path.join(ROOT, 'scan-inventory.ps1') });
        const preview = uninstall.previewScanUninstall(scanResult, { selectedIds: body.selectedIds, dataMode: body.dataMode || 'backup' });
        return send(res, 200, preview);
      } catch (err) {
        return send(res, 400, { ok: false, error: err.message });
      }
    }
    if (url.pathname === '/api/check-folder') {
      return send(res, 200, await setup.checkFolder(dirArg(body.path), { expectedUrl: body.url, expectedBranch: body.branch }));
    }
    if (url.pathname === '/api/browse-folder') {
      const result = await setup.browseFolder({
        current: body.current,
        scriptPath: path.join(ROOT, 'browse-folder.ps1'),
      });
      return send(res, result.ok ? 200 : (result.error === 'not available' ? 501 : 200), result);
    }
    if (url.pathname === '/api/install') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      const log = (line) => res.write(JSON.stringify({ line }) + '\n');
      try {
        const src = setup.resolveSource(body);
        log('Source: ' + src.url + ' @ ' + src.branch);
        const result = await setup.install({
          dest: dirArg(body.dir),
          url: src.url,
          branch: src.branch,
          settings: body.settings || {},
          autostart: !!body.autostart,
          log,
          onBeforeConfig: async (dir, logFn) => {
            const r = body.restore;
            if (!r || r.skip || !r.path) return;
            logFn('Restoring data from backup ' + r.path);
            const out = await backup.restoreBackup({
              file: r.path, destDir: dir, mode: r.mode || 'merge', selected: r.selected,
              confirmReplace: !!r.confirmReplace || r.mode === 'replace',
              log: logFn,
            });
            if (out.needsConfirm) throw new Error('Restore needs a conflict choice (Merge or Replace).');
            if (!out.ok && !out.cancelled) throw new Error(out.error || 'Restore failed.');
            if (out.ok && out.counts) {
              logFn('Restored ' + out.counts.restored + ' files; skipped ' + out.counts.skipped + ' (secrets: ' + out.counts.secrets + ').');
            }
          },
        });
        if (process.platform === 'win32') {
          await createWindowsExtras(result.dir, { autostart: !!body.autostart, log });
        }
        if (body.start !== false && process.env.CREW_SETUP_SKIP_START !== '1') {
          log('Starting Crew…');
          await startCrew(result.dir, body.settings && body.settings.port);
          log('Crew is running at http://localhost:' + ((body.settings && body.settings.port) || 7777));
        }
        res.write(JSON.stringify({ ok: true, dir: result.dir, port: (body.settings && body.settings.port) || 7777 }) + '\n');
      } catch (err) {
        res.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
      }
      return res.end();
    }
    if (url.pathname === '/api/source') {
      try {
        const dir = body.dir || START_DIR;
        const next = await setup.switchSource(dir, { url: body.url, branch: body.branch });
        return send(res, 200, { ok: true, ...next });
      } catch (err) {
        return send(res, 409, { ok: false, error: err.message, dirtyFiles: err.dirtyFiles || [] });
      }
    }
    if (url.pathname === '/api/uninstall') {
      try {
        const scanResult = body.scan || await scan.scanCrew({ currentDir: body.dir || START_DIR, extraDirs: [START_DIR], scriptPath: path.join(ROOT, 'scan-inventory.ps1') });
        const dataMode = body.dataMode || 'backup';
        const dryRun = !!body.dryRun || DRY_RUN;
        const preview = uninstall.previewScanUninstall(scanResult, { selectedIds: body.selectedIds, dataMode });
        if (dryRun) {
          const result = await uninstall.runScanUninstall({
            scanResult, selectedIds: body.selectedIds, dataMode, dryRun: true, backupPath: body.backupPath || preview.backupPath, sourceRoot: ROOT,
            selfPid: process.pid, selfPpid: process.ppid,
          });
          return send(res, 200, result);
        }
        if (uninstall.needsHandoff(preview.folders, { cwd: process.cwd(), scriptPath: __filename, execPath: process.execPath })) {
          let backup = null;
          if (dataMode === 'backup' && preview.userData.length) {
            backup = await uninstall.backupMany(preview.userData, body.backupPath || preview.backupPath);
          }
          const copied = uninstall.copyUninstallerToTemp({ sourceRoot: ROOT });
          const planPath = path.join(copied.dir, 'uninstall-plan.json');
          fs.writeFileSync(planPath, JSON.stringify({
            scanResult, selectedIds: body.selectedIds, dataMode, backupPath: (backup && backup.path) || body.backupPath || preview.backupPath,
            waitForPid: process.pid, createdAt: new Date().toISOString(),
          }, null, 2));
          const child = spawn(process.execPath, [path.join(copied.dir, 'setup-wizard.js'), '--exec-plan', '--plan', planPath], {
            detached: true, stdio: 'ignore', cwd: copied.dir,
          });
          child.unref();
          return send(res, 200, { ok: true, handedOff: true, tempDir: copied.dir, backup, preview, planPath });
        }
        const result = await uninstall.runScanUninstall({
          scanResult, selectedIds: body.selectedIds, dataMode, dryRun: false, backupPath: body.backupPath || preview.backupPath, sourceRoot: ROOT,
          selfPid: process.pid, selfPpid: process.ppid,
        });
        return send(res, 200, result);
      } catch (err) {
        return send(res, 400, { ok: false, error: err.message });
      }
    }
    if (url.pathname === '/api/open') {
      const target = body.url || '';
      if (!/^https?:\/\/localhost[:/]/i.test(target) && !/^https?:\/\/127\.0\.0\.1[:/]/i.test(target)) {
        return send(res, 400, { error: 'Only a local Crew URL can be opened from the wizard.' });
      }
      openUrl(target);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/claude-login') {
      const child = spawn(process.env.CLAUDE_PATH || 'claude', ['auth', 'login'], { stdio: 'ignore', detached: true });
      child.unref();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    if (!res.headersSent) send(res, 500, { error: err.message });
  }
}

async function createWindowsExtras(dir, { autostart, log }) {
  const ps = `
    $Dir = '${dir.replace(/'/g, "''")}'
    $sh = New-Object -ComObject WScript.Shell
    $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude Crew.lnk'
    if (-not (Test-Path $desk)) {
      $s = $sh.CreateShortcut($desk)
      $s.TargetPath = Join-Path $Dir 'Start Crew.bat'
      $s.WorkingDirectory = $Dir
      $s.Description = 'Open Claude Crew'
      $s.Save()
    }
    ${autostart ? `
    $lnk = $sh.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Crew tray.lnk'))
    $lnk.TargetPath = "$env:WINDIR\\System32\\conhost.exe"
    $lnk.Arguments = '--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "' + (Join-Path $Dir 'crew-tray.ps1') + '"'
    $lnk.WorkingDirectory = $Dir
    $lnk.Description = 'Claude Crew tray icon'
    $lnk.Save()
    ` : ''}
  `;
  // The install dir is quoted as a PowerShell single-quoted literal (quotes doubled). This runs only after a local install.
  await setup.execFileP('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  log(autostart ? 'Created Desktop and Startup shortcuts' : 'Created a Desktop shortcut');
  const manifest = setup.readManifest(dir) || { created: [] };
  const home = process.env.USERPROFILE || os.homedir();
  const desktop = path.join(home, 'Desktop', 'Claude Crew.lnk');
  manifest.created = manifest.created || [];
  manifest.created.push({ type: 'desktopShortcut', path: desktop, name: 'Claude Crew.lnk' });
  if (autostart) {
    manifest.created.push({
      type: 'startupShortcut',
      path: path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Claude Crew tray.lnk'),
      name: 'Claude Crew tray.lnk',
    });
  }
  setup.writeManifest(dir, manifest);
}

async function startCrew(dir, port) {
  const cmd = path.join(dir, 'run-crew.cmd');
  if (process.platform === 'win32' && fs.existsSync(cmd)) {
    spawn('cmd.exe', ['/c', cmd], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn(process.execPath, [path.join(dir, 'server.js')], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
  }
  const p = port || 7777;
  for (let i = 0; i < 40; i++) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: p, path: '/api/machines/link', timeout: 1000 }, (r) => { r.resume(); resolve(r.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Crew did not start in time. Check data/crew.log in the install folder.');
}

function openUrl(target) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', target], () => {});
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], () => {});
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(null);
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function runPlanAndExit() {
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  const pid = plan.waitForPid;
  if (pid) {
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 500)); } catch { break; }
    }
  }
  const result = plan.scanResult
    ? await uninstall.runScanUninstall({
        scanResult: plan.scanResult,
        selectedIds: plan.selectedIds,
        dataMode: plan.dataMode || 'backup',
        dryRun: !!plan.dryRun || DRY_RUN,
        backupPath: plan.backupPath,
        sourceRoot: __dirname,
        cwd: process.cwd(),
        scriptPath: __filename,
      })
    : await uninstall.runUninstall({
        installDir: plan.installDir || START_DIR,
        dataMode: plan.dataMode || 'backup',
        dryRun: !!plan.dryRun || DRY_RUN,
        backupPath: plan.backupPath,
      });
  console.log(result.dryRun ? 'Dry-run complete.' : 'Uninstall complete.');
  if (result.backup && result.backup.path) console.log('Backup: ' + result.backup.path);
  process.exit(result.ok ? 0 : 1);
}

(async () => {
  if (WANT_SCAN) {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'crew-scan.js'), ...args.filter((a) => a !== '--uninstall')], { stdio: 'inherit' });
    process.exit(r.status || 0);
  }
  if (PLAN_PATH && flag('exec-plan')) {
    await runPlanAndExit();
    return;
  }
  if (WANT_UNINSTALL && flag('headless')) {
    const result = await uninstall.runUninstall({ installDir: START_DIR, dataMode: opt('data-mode', 'backup'), dryRun: DRY_RUN, backupPath: opt('backup') });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
    return;
  }
  let port = PORT_START, server = null;
  for (let i = 0; i < 20 && !server; i++) {
    server = await listen(port + i);
    if (server) port = port + i;
  }
  if (!server) throw new Error('Could not bind a local port for the wizard.');
  const page = 'http://127.0.0.1:' + port + '/' + (WANT_UNINSTALL ? '?mode=uninstall' : (setup.detectInstall(START_DIR).existing ? '?mode=existing' : ''));
  console.log('Claude Crew setup wizard: ' + page);
  if (!NO_OPEN) openUrl(page);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
