'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const un = require('../lib/uninstall');

const HOME_ROOT = '/workspace/claudecrew-design/.testhomes';
function tmp() {
  fs.mkdirSync(HOME_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(HOME_ROOT, 'u-'));
}

describe('path guards', () => {
  test('rejects an empty path, the drive root, and the user profile root', () => {
    const home = tmp();
    assert.throws(() => un.assertSafeInstallDir(''), /empty/i);
    assert.throws(() => un.assertSafeInstallDir('   '), /empty/i);
    assert.throws(() => un.assertSafeInstallDir('/'), /root/i);
    assert.throws(() => un.assertSafeInstallDir(home, { homedir: home, env: { HOME: home, USERPROFILE: home } }), /profile root/i);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('allows a normal install folder and blocks a symlink that escapes it', () => {
    const home = tmp();
    const install = path.join(home, 'ClaudeCrew');
    const outside = path.join(home, 'secret-docs');
    fs.mkdirSync(install, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'passwords.txt'), 'nope');
    const safe = un.assertSafeInstallDir(install, { homedir: home, env: { HOME: home } });
    assert.equal(safe, path.resolve(install));
    const link = path.join(install, 'escape');
    fs.symlinkSync(outside, link);
    const check = un.isSafeToDelete(link, install);
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'symlink-escape');
    // A regular file inside is fine.
    const inner = path.join(install, 'server.js');
    fs.writeFileSync(inner, 'ok');
    assert.equal(un.isSafeToDelete(inner, install).ok, true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('deleteInside will not follow a junction/symlink out of the install folder', async () => {
    const home = tmp();
    const install = path.join(home, 'ClaudeCrew');
    const outside = path.join(home, 'keep-me');
    fs.mkdirSync(install, { recursive: true });
    fs.mkdirSync(outside);
    const precious = path.join(outside, 'precious.txt');
    fs.writeFileSync(precious, 'keep');
    fs.symlinkSync(outside, path.join(install, 'link-out'));
    fs.writeFileSync(path.join(install, 'server.js'), 'app');
    const actions = await un.deleteInside(install, [
      { rel: 'link-out', path: path.join(install, 'link-out') },
      { rel: 'server.js', path: path.join(install, 'server.js') },
    ]);
    assert.ok(actions.some((a) => a.action === 'skip' && a.reason === 'symlink-escape'));
    assert.ok(fs.existsSync(precious));
    assert.equal(fs.existsSync(path.join(install, 'server.js')), false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('process selection', () => {
  test('isCrewNodeProcess requires node, server.js, and the install folder', () => {
    const dir = '/home/box/ClaudeCrew';
    assert.equal(un.isCrewNodeProcess('node server.js', dir), true);
    assert.equal(un.isCrewNodeProcess('/usr/bin/node /home/box/ClaudeCrew/server.js', dir), true);
    assert.equal(un.isCrewNodeProcess('node other.js', dir), false);
    assert.equal(un.isCrewNodeProcess('python server.js', dir), false);
    assert.equal(un.isCrewNodeProcess('node /tmp/elsewhere/server.js', dir), false);
    assert.equal(un.isCrewNodeProcess('', dir), false);
  });

  test('findCrewProcess uses the PID file first, then the port, and ignores a non-Crew PID', async () => {
    const installDir = '/home/box/ClaudeCrew';
    const cmds = {
      111: 'node /home/box/ClaudeCrew/server.js',
      222: 'node /opt/other/server.js',
      333: 'nginx',
    };
    const found = await un.findCrewProcess({
      installDir,
      port: 7777,
      pidFile: { pid: 111, port: 7777 },
      cmdForPid: async (pid) => cmds[pid] || '',
      listeningPid: async () => 222,
    });
    assert.equal(found.pid, 111);
    assert.equal(found.via, 'pid-file');

    const viaPort = await un.findCrewProcess({
      installDir,
      port: 7777,
      pidFile: null,
      cmdForPid: async (pid) => cmds[pid] || '',
      listeningPid: async () => 111,
    });
    assert.equal(viaPort.pid, 111);
    assert.equal(viaPort.via, 'port');

    const ignored = await un.findCrewProcess({
      installDir,
      port: 7777,
      pidFile: { pid: 333 },
      cmdForPid: async (pid) => cmds[pid] || '',
      listeningPid: async () => 222,
    });
    assert.equal(ignored, null);
  });

  test('stopCrewProcess refuses to kill a PID that is not Crew', async () => {
    const killed = [];
    const r = await un.stopCrewProcess({
      pid: 99,
      installDir: '/home/box/ClaudeCrew',
      cmdForPid: async () => 'node /var/app/server.js',
      killFn: async (pid) => killed.push(pid),
    });
    assert.equal(r.ok, false);
    assert.equal(killed.length, 0);
    assert.match(r.error, /will not stop/);
  });

  test('stopCrewProcess dry-run does not kill, and a verified Crew PID can be stopped', async () => {
    const killed = [];
    const dry = await un.stopCrewProcess({
      pid: 42,
      installDir: '/home/box/ClaudeCrew',
      dryRun: true,
      cmdForPid: async () => 'node /home/box/ClaudeCrew/server.js --open',
      killFn: async (pid) => killed.push(pid),
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(killed.length, 0);
    const real = await un.stopCrewProcess({
      pid: 42,
      installDir: '/home/box/ClaudeCrew',
      cmdForPid: async () => 'node /home/box/ClaudeCrew/server.js --open',
      killFn: async (pid) => killed.push(pid),
    });
    assert.equal(real.ok, true);
    assert.deepEqual(killed, [42]);
  });
});

describe('uninstall dry-run and backup location', () => {
  test('preview lists user data, shortcuts, and a backup path outside the install folder', () => {
    const home = tmp();
    const install = path.join(home, 'ClaudeCrew');
    fs.mkdirSync(path.join(install, 'data'), { recursive: true });
    fs.mkdirSync(path.join(install, 'workspace', 'assistant'), { recursive: true });
    fs.writeFileSync(path.join(install, 'crew.config.json'), JSON.stringify({
      settings: { port: 7777 },
      agents: [{ id: 'assistant', cwd: 'workspace/assistant' }, { id: 'webapp', cwd: path.join(home, 'Projects', 'app') }],
    }));
    fs.writeFileSync(path.join(install, 'server.js'), 'app');
    fs.writeFileSync(path.join(install, 'install-manifest.json'), JSON.stringify({
      version: 1, installDir: install, created: [
        { type: 'desktopShortcut', path: path.join(home, 'Desktop', 'Claude Crew.lnk'), name: 'Claude Crew.lnk' },
      ],
    }));
    fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
    fs.writeFileSync(path.join(home, 'Desktop', 'Claude Crew.lnk'), 'lnk');
    const prev = un.previewUninstall(install, {
      dataMode: 'backup',
      env: { HOME: home, USERPROFILE: home },
      homedir: home,
      now: new Date('2026-11-21T13:30:00'),
    });
    assert.equal(prev.installDir, path.resolve(install));
    assert.ok(prev.userData.some((u) => u.rel === 'data'));
    assert.ok(prev.userData.some((u) => u.rel === 'crew.config.json'));
    assert.ok(prev.userData.some((u) => /workspace/.test(u.rel)));
    assert.ok(!prev.userData.some((u) => /Projects/.test(u.path))); // outside cwd is not listed
    assert.ok(prev.backupPath.startsWith(home));
    assert.ok(prev.backupPath.includes('ClaudeCrew-backup-'));
    assert.ok(prev.backupPath.endsWith('.zip'));
    assert.ok(!prev.backupPath.startsWith(install + path.sep));
    assert.notEqual(prev.backupPath, install);
    const setup = require('../lib/setup');
    assert.equal(setup.isInside(prev.backupPath, install), false);
    assert.ok(prev.artifacts.some((a) => a.type === 'desktopShortcut'));
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('runUninstall dry-run reports backup, stop, and deletes without changing the disk', async () => {
    const home = tmp();
    const install = path.join(home, 'ClaudeCrew');
    fs.mkdirSync(path.join(install, 'data'), { recursive: true });
    fs.writeFileSync(path.join(install, 'data', 'chat.jsonl'), 'msg');
    fs.writeFileSync(path.join(install, 'crew.config.json'), JSON.stringify({ settings: { port: 7777 } }));
    fs.writeFileSync(path.join(install, 'server.js'), 'app');
    const killed = [];
    const result = await un.runUninstall({
      installDir: install,
      dataMode: 'backup',
      dryRun: true,
      env: { HOME: home, USERPROFILE: home },
      homedir: home,
      now: new Date('2026-11-21T13:30:00'),
      findProcess: async () => ({ pid: 55, via: 'pid-file', cmdline: 'node ' + install + '/server.js' }),
      stopProcess: async (opts) => { if (!opts.dryRun) killed.push(opts.pid); return { ok: true, dryRun: true, pid: opts.pid }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(killed.length, 0);
    assert.ok(fs.existsSync(path.join(install, 'server.js')));
    assert.ok(fs.existsSync(path.join(install, 'data', 'chat.jsonl')));
    assert.ok(result.actions.some((a) => a.action === 'backup' && a.dryRun));
    assert.ok(result.actions.some((a) => a.action === 'stop'));
    assert.ok(result.actions.some((a) => a.action === 'delete'));
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('keep mode leaves user data and backup mode writes a zip outside the install folder', async () => {
    const home = tmp();
    const install = path.join(home, 'ClaudeCrew');
    fs.mkdirSync(path.join(install, 'data'), { recursive: true });
    fs.writeFileSync(path.join(install, 'data', 'chat.jsonl'), 'msg');
    fs.writeFileSync(path.join(install, 'crew.config.json'), JSON.stringify({ settings: { port: 7777 } }));
    fs.writeFileSync(path.join(install, 'server.js'), 'app');
    const keep = un.previewUninstall(install, { dataMode: 'keep', env: { HOME: home, USERPROFILE: home }, homedir: home });
    assert.ok(keep.willKeep.some((u) => u.rel === 'data'));
    assert.ok(keep.willDelete.some((d) => d.rel === 'server.js'));
    assert.ok(!keep.willDelete.some((d) => d.rel === 'data'));

    const dest = path.join(home, 'ClaudeCrew-backup-test.zip');
    const zip = await un.createBackupZip(install, dest, keep.userData);
    assert.equal(zip.ok, true);
    assert.equal(fs.existsSync(dest), true);
    assert.ok(fs.statSync(dest).size > 0);
    await assert.rejects(() => un.createBackupZip(install, path.join(install, 'oops.zip'), keep.userData), /outside/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

const backup = require('../lib/backup');
const lock = require('../lib/launcher-lock');
const scan = require('../lib/scan');

function stubInstall(root, { data = 'chat', extractName = false } = {}) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server.js'), 'app');
  fs.writeFileSync(path.join(root, 'run-crew.cmd'), '@echo off\n');
  fs.writeFileSync(path.join(root, 'crew-tray.ps1'), '# tray');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'claude-crew' }));
  fs.writeFileSync(path.join(root, 'crew.config.json'), JSON.stringify({ settings: { port: 7777 }, agents: [] }));
  if (data) fs.writeFileSync(path.join(root, 'data', 'chat.jsonl'), String(data));
  return root;
}

describe('backup verify and uninstall abort', () => {
  test('verifyBackup rejects a missing, empty, or count-mismatched zip when data/ has files', async () => {
    const home = tmp();
    const install = stubInstall(path.join(home, 'ClaudeCrew'));
    const userData = un.userDataPaths(install).map((u) => ({ ...u, installDir: install }));
    assert.equal(backup.verifyBackup(path.join(home, 'missing.zip'), { userData }).ok, false);
    const empty = path.join(home, 'empty.zip');
    fs.writeFileSync(empty, '');
    const emptyResult = backup.verifyBackup(empty, { userData });
    assert.equal(emptyResult.ok, false);
    assert.match(emptyResult.error, /will not continue/i);

    const good = path.join(home, 'ClaudeCrew-backup-good.zip');
    const wrote = await backup.writeBackup({ userData, dest: good });
    assert.equal(wrote.ok, true);
    const ok = backup.verifyBackup(good, { userData });
    assert.equal(ok.ok, true);
    assert.ok(ok.fileCount >= 1);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('runScanUninstall aborts and deletes nothing when the backup fails', async () => {
    const home = tmp();
    const install = stubInstall(path.join(home, 'ClaudeCrew'));
    const dest = path.join(home, 'ClaudeCrew-backup-fail.zip');
    const scanResult = await scan.scanCrew({
      env: { USERPROFILE: home, HOME: home }, homedir: home, platform: 'linux',
      currentDir: install, inventory: { processes: [], shortcuts: [], tasks: [], runKeys: [] },
    });
    let threw = null;
    try {
      await un.runScanUninstall({
        scanResult,
        dataMode: 'backup',
        dryRun: false,
        backupPath: dest,
        env: { USERPROFILE: home, HOME: home },
        homedir: home,
        sourceRoot: path.join(__dirname, '..'),
        cwd: home,
        scriptPath: path.join(home, 'other.js'),
        backupFn: async (_userData, d) => {
          fs.writeFileSync(d, '');
          return { ok: true, path: d, counts: { files: 0, bytes: 0 } };
        },
        rescan: async () => ({ groups: { processes: [], tray: [] } }),
      });
    } catch (err) { threw = err; }
    assert.ok(threw, 'expected backup failure to throw');
    assert.match(String(threw.message), /will not continue/i);
    assert.ok(fs.existsSync(path.join(install, 'server.js')));
    assert.ok(fs.existsSync(path.join(install, 'data', 'chat.jsonl')));
    assert.equal(fs.existsSync(path.join(install, 'crew.stop')), false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('stop flag, stop order, and respawn re-scan', () => {
  test('writeStopFlag is checked by hasStopFlag and by run-crew.cmd', () => {
    const home = tmp();
    const install = stubInstall(path.join(home, 'ClaudeCrew'));
    assert.equal(un.hasStopFlag(install), false);
    const written = un.writeStopFlag(install);
    assert.ok(written.some((p) => p.endsWith('crew.stop')));
    assert.equal(un.hasStopFlag(install), true);
    const src = fs.readFileSync(path.join(__dirname, '..', 'run-crew.cmd'), 'utf8');
    assert.match(src, /if exist "%~dp0crew\.stop"/);
    assert.match(src, /goto :stopflag/);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('planProcessStops ranks run-crew loops before servers', () => {
    const procs = [
      { pid: 20, kind: 'server', name: 'node.exe', commandLine: 'node C:\\\\Crew\\\\server.js' },
      { pid: 10, kind: 'helper', name: 'cmd.exe', commandLine: 'cmd.exe /c C:\\\\Crew\\\\run-crew.cmd' },
      { pid: 15, kind: 'tray', name: 'powershell.exe', commandLine: 'powershell.exe -File C:\\\\Crew\\\\crew-tray.ps1' },
    ];
    const plan = un.planProcessStops(procs, { selfPid: 99, selfPpid: 98 });
    const ranks = Object.fromEntries(plan.planned.map((p) => [p.pid, p.stopRank]));
    assert.equal(ranks[10], 0);
    assert.equal(ranks[15], 1);
    assert.equal(ranks[20], 2);
    assert.ok(plan.planned.findIndex((p) => p.pid === 10) < plan.planned.findIndex((p) => p.pid === 20));
  });

  test('stopUntilClean re-scans respawned servers and retries up to 3 times before files stay put', async () => {
    const home = tmp();
    const install = stubInstall(path.join(home, 'ClaudeCrew'));
    const loop = { pid: 100, kind: 'helper', name: 'cmd.exe', commandLine: 'cmd.exe /c ' + install + '/run-crew.cmd' };
    const server1 = { pid: 200, kind: 'server', name: 'node.exe', commandLine: 'node ' + install + '/server.js' };
    const server2 = { pid: 201, kind: 'server', name: 'node.exe', commandLine: 'node ' + install + '/server.js' };
    const killed = [];
    let scans = 0;
    const rescan = async () => {
      scans += 1;
      if (scans === 1) return { groups: { processes: [loop, server2], tray: [] } };
      if (scans === 2) return { groups: { processes: [server2], tray: [] } };
      return { groups: { processes: [server2], tray: [] } };
    };
    const result = await un.runScanUninstall({
      scanResult: {
        items: [
          { id: 'folder:' + install, type: 'folder', path: install, defaultChecked: true },
          { id: 'process:100', type: 'process', pid: 100, kind: 'helper', name: 'cmd.exe', commandLine: loop.commandLine, defaultChecked: true },
          { id: 'process:200', type: 'process', pid: 200, kind: 'server', name: 'node.exe', commandLine: server1.commandLine, defaultChecked: true },
        ],
        groups: { folders: [{ id: 'folder:' + install, type: 'folder', path: install, defaultChecked: true }], processes: [loop, server1], tray: [], shortcuts: [], scheduledTasks: [], runKeys: [] },
      },
      dataMode: 'backup',
      dryRun: false,
      backupPath: path.join(home, 'ClaudeCrew-backup-respawn.zip'),
      env: { USERPROFILE: home, HOME: home },
      homedir: home,
      sourceRoot: path.join(__dirname, '..'),
      cwd: home,
      scriptPath: path.join(home, 'other.js'),
      platform: 'linux',
      run: async (file, args) => { killed.push({ file, args }); return { ok: true, code: 0 }; },
      rescan,
      maxStopTries: 3,
    });
    assert.equal(result.ok, false);
    assert.equal(result.incomplete, true);
    assert.equal(result.reason, 'still-running');
    assert.ok(result.backup && result.backup.path);
    assert.ok(fs.existsSync(result.backup.path));
    assert.ok(backup.verifyBackup(result.backup.path, { userData: un.userDataPaths(install).map((u) => ({ ...u, installDir: install })) }).ok);
    assert.ok(result.actions.some((a) => a.action === 'rescan'));
    assert.ok(scans >= 3 || result.stillRunning.length);
    assert.ok(fs.existsSync(path.join(install, 'server.js')), 'must not delete files while a server is still running');
    assert.ok(fs.existsSync(path.join(install, 'data', 'chat.jsonl')));
    assert.equal(un.hasStopFlag(install), true);
    // Loops were targeted before the server on the first attempt.
    const stops = result.actions.filter((a) => a.action === 'stop');
    const firstLoop = stops.find((a) => a.pid === 100);
    const firstServer = stops.find((a) => a.pid === 200);
    assert.ok(firstLoop);
    assert.ok(firstServer);
    assert.ok(result.actions.indexOf(firstLoop) < result.actions.indexOf(firstServer));
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('after a clean stop, data/ is removed last and the install folder is removed if empty', async () => {
    const home = tmp();
    const install = stubInstall(path.join(home, 'ClaudeCrew'));
    const order = [];
    const origRm = fs.rmSync;
    const hookRm = (p, opts) => { order.push(path.relative(install, p) || '.'); origRm(p, opts); };
    const scanResult = await scan.scanCrew({
      env: { USERPROFILE: home, HOME: home }, homedir: home, platform: 'linux',
      currentDir: install, inventory: { processes: [], shortcuts: [], tasks: [], runKeys: [] },
    });
    const result = await un.runScanUninstall({
      scanResult,
      dataMode: 'backup',
      dryRun: false,
      backupPath: path.join(home, 'ClaudeCrew-backup-clean.zip'),
      env: { USERPROFILE: home, HOME: home },
      homedir: home,
      sourceRoot: path.join(__dirname, '..'),
      cwd: home,
      scriptPath: path.join(home, 'other.js'),
      rm: hookRm,
      rescan: async () => ({ groups: { processes: [], tray: [] } }),
    });
    assert.equal(result.ok, true);
    assert.equal((result.stillRunning || []).length, 0);
    assert.ok(result.backup && fs.existsSync(result.backup.path));
    assert.equal(fs.existsSync(path.join(install, 'server.js')), false);
    assert.equal(fs.existsSync(path.join(install, 'data', 'chat.jsonl')), false);
    const dataIdx = order.findIndex((r) => r === 'data' || r.startsWith('data'));
    const serverIdx = order.findIndex((r) => r === 'server.js');
    if (dataIdx >= 0 && serverIdx >= 0) assert.ok(serverIdx < dataIdx, 'app files before data/');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('locate the real install and never delete the uninstaller home', () => {
  test('locateInstalls prefers the live install over a Mods extract, using the manifest, task, or run-crew command line', () => {
    const home = tmp();
    const install = stubInstall(path.join(home, 'ClaudeCrew'));
    fs.writeFileSync(path.join(install, 'install-manifest.json'), JSON.stringify({ version: 1, installDir: install }));
    const extract = stubInstall(path.join(home, 'OneDrive', 'Desktop', 'Mods', 'claudecrew-crew-mods'), { data: null });
    try { fs.rmSync(path.join(extract, 'data'), { recursive: true, force: true }); } catch { /* none */ }
    fs.writeFileSync(path.join(extract, 'install-manifest.json'), JSON.stringify({ version: 1, installDir: install }));

    const fromManifest = un.locateInstalls({
      currentDir: extract,
      env: { USERPROFILE: home, HOME: home },
      homedir: home,
      platform: 'linux',
    });
    assert.ok(fromManifest.recommended);
    assert.equal(un.sameDir(fromManifest.recommended.path, install), true);
    assert.equal(fromManifest.launcherIsInstall, false);
    assert.match(fromManifest.message, /live install appears to be/i);
    assert.match(fromManifest.message, /will not be deleted/i);

    const fromTask = un.locateInstalls({
      currentDir: extract,
      taskActions: [{ execute: 'conhost.exe', arguments: '--headless cmd.exe /c "' + install + path.sep + 'run-crew.cmd"', workingDirectory: install }],
      env: { USERPROFILE: home, HOME: home },
      homedir: home,
      platform: 'linux',
    });
    assert.equal(un.sameDir(fromTask.recommended.path, install), true);

    const fromProc = un.locateInstalls({
      currentDir: extract,
      processCommandLines: ['cmd.exe /c "' + install + path.sep + 'run-crew.cmd"'],
      env: { USERPROFILE: home, HOME: home },
      homedir: home,
      platform: 'linux',
    });
    assert.equal(un.sameDir(fromProc.recommended.path, install), true);
    assert.ok(fromProc.recommended.sources.includes('run-crew'));

    const annotated = un.annotateScanForUninstall({
      groups: {
        folders: [
          { id: 'folder:' + extract, type: 'folder', path: extract, defaultChecked: true, reason: '' },
          { id: 'folder:' + install, type: 'folder', path: install, defaultChecked: true, reason: '' },
        ],
      },
      items: [
        { id: 'folder:' + extract, type: 'folder', path: extract, defaultChecked: true },
        { id: 'folder:' + install, type: 'folder', path: install, defaultChecked: true },
      ],
    }, fromManifest);
    const ext = annotated.groups.folders.find((f) => un.sameDir(f.path, extract));
    const live = annotated.groups.folders.find((f) => un.sameDir(f.path, install));
    assert.equal(ext.defaultChecked, false);
    assert.equal(ext.role, 'source-or-extract');
    assert.equal(live.recommended, true);
    assert.equal(live.defaultChecked, true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('runScanUninstall will not delete the folder it was started from unless that folder is the install', async () => {
    const home = tmp();
    const install = stubInstall(path.join(home, 'ClaudeCrew'));
    const extract = stubInstall(path.join(home, 'OneDrive', 'Desktop', 'Mods', 'claudecrew-crew-mods'), { data: null });
    try { fs.rmSync(path.join(extract, 'data'), { recursive: true, force: true }); } catch { /* none */ }
    const items = [
      { id: 'folder:' + extract, type: 'folder', path: extract, defaultChecked: true },
      { id: 'folder:' + install, type: 'folder', path: install, defaultChecked: true },
    ];
    const scanResult = {
      items,
      groups: { folders: items, processes: [], tray: [], shortcuts: [], scheduledTasks: [], runKeys: [] },
    };
    const result = await un.runScanUninstall({
      scanResult,
      selectedIds: items.map((i) => i.id),
      dataMode: 'backup',
      dryRun: false,
      backupPath: path.join(home, 'ClaudeCrew-backup-locate.zip'),
      env: { USERPROFILE: home, HOME: home },
      homedir: home,
      sourceRoot: path.join(__dirname, '..'),
      cwd: home,
      scriptPath: path.join(home, 'other.js'),
      launcherDir: extract,
      rescan: async () => ({ groups: { processes: [], tray: [] } }),
    });
    assert.equal(result.ok, true);
    assert.ok(result.actions.some((a) => a.action === 'skip' && a.reason === 'uninstaller-home'));
    assert.ok(fs.existsSync(path.join(extract, 'server.js')), 'extract must not be emptied');
    assert.equal(fs.existsSync(path.join(install, 'server.js')), false);
    assert.equal(fs.existsSync(path.join(install, 'data', 'chat.jsonl')), false);
    assert.ok(result.backup && fs.existsSync(result.backup.path));
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('mayDeleteFolder refuses the uninstaller home when it is not the install', () => {
    const extract = '/home/box/Mods/claudecrew-crew-mods';
    const install = '/home/box/ClaudeCrew';
    const no = un.mayDeleteFolder(extract, { launcherDir: extract, recommended: { path: install } });
    assert.equal(no.ok, false);
    assert.equal(no.reason, 'uninstaller-home');
    const yes = un.mayDeleteFolder(install, { launcherDir: extract, recommended: { path: install } });
    assert.equal(yes.ok, true);
    const self = un.mayDeleteFolder(install, { launcherDir: install, recommended: { path: install }, cwd: '/tmp/crew-uninstall-1', scriptPath: '/tmp/crew-uninstall-1/setup-wizard.js' });
    assert.equal(self.ok, true);
  });
});

describe('single-instance launcher lock', () => {
  test('acquireLauncherLock rejects a second live launcher and replaces a stale lock', async () => {
    const home = tmp();
    const install = stubInstall(path.join(home, 'ClaudeCrew'));
    const first = await lock.acquireLauncherLock(install, { pid: 4242, killFn: () => {}, now: new Date('2026-11-23T16:40:00Z') });
    assert.equal(first.ok, true);
    const second = await lock.acquireLauncherLock(install, {
      pid: 4243,
      killFn: () => {},
      cmdForPid: async () => 'cmd.exe /c "' + install + path.sep + 'run-crew.cmd"',
    });
    assert.equal(second.ok, false);
    assert.equal(second.alreadyRunning, true);
    assert.match(second.message, /already running/i);
    assert.ok(!/kill|taskkill/i.test(second.message));

    const stale = await lock.acquireLauncherLock(install, {
      pid: 5000,
      killFn: (pid) => { const err = new Error('gone'); err.code = 'ESRCH'; throw err; },
    });
    assert.equal(stale.ok, true);
    const rec = lock.readLock(install);
    assert.equal(rec.pid, 5000);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
