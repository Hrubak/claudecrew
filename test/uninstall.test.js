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
