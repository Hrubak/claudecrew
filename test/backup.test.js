'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const setup = require('../lib/setup');
const un = require('../lib/uninstall');
const backup = require('../lib/backup');
const zip = require('../lib/zip');

const HOME_ROOT = '/workspace/claudecrew-design/.testhomes';
function tmp() {
  fs.mkdirSync(HOME_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(HOME_ROOT, 'b-'));
}

describe('normalizeInstallDir (Windows %~dp0 quote)', () => {
  test('strips a trailing quote and trailing separators, and cmd files pass %~dp0.', () => {
    const n = setup.normalizeInstallDir('C:\\Users\\hruba\\OneDrive\\Desktop\\Mods\\claudecrew-crew-mods"', { resolvePath: (p) => p });
    assert.equal(n, 'C:\\Users\\hruba\\OneDrive\\Desktop\\Mods\\claudecrew-crew-mods');
    assert.ok(!n.endsWith('"'));
    const slash = setup.normalizeInstallDir('/tmp/crew/', { resolvePath: (p) => p });
    assert.equal(slash, '/tmp/crew');
    const quoted = setup.normalizeInstallDir('"/tmp/crew"', { resolvePath: (p) => p });
    assert.equal(quoted, '/tmp/crew');
    assert.equal(setup.normalizeInstallDir('/'), '/');
    const uninstall = fs.readFileSync(path.join(__dirname, '..', 'uninstall.cmd'), 'utf8');
    const setupCmd = fs.readFileSync(path.join(__dirname, '..', 'setup.cmd'), 'utf8');
    assert.ok(uninstall.includes('--dir "%~dp0."'));
    assert.ok(setupCmd.includes('--dir "%~dp0."'));
    assert.equal(uninstall.includes('--dir "%~dp0"'), false);
    assert.equal(setupCmd.includes('--dir "%~dp0"'), false);
  });
});

describe('process stop tree (Beast table)', () => {
  function beastProcs(projects, zipDir) {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    const conhost = 'C:\\Windows\\System32\\conhost.exe';
    const mods = 'C:\\Users\\hruba\\OneDrive\\Desktop\\Mods\\claudecrew-crew-mods';
    return [
      { pid: 9436, parentPid: 7972, name: 'node.exe', kind: 'server', commandLine: '"' + node + '"  server.js' },
      { pid: 7972, parentPid: 16420, name: 'cmd.exe', kind: 'helper', commandLine: cmd + ' /c "' + projects + path.sep + 'run-crew.cmd"' },
      { pid: 17180, parentPid: 16420, name: 'cmd.exe', kind: 'helper', commandLine: cmd + ' /c "' + zipDir + path.sep + 'run-crew.cmd"' },
      { pid: 16400, parentPid: 888, name: 'conhost.exe', kind: 'tray', commandLine: conhost + ' --headless ' + ps + ' -File "' + zipDir + path.sep + 'crew-tray.ps1"' },
      { pid: 16420, parentPid: 16400, name: 'powershell.exe', kind: 'tray', commandLine: ps + ' -File "' + zipDir + path.sep + 'crew-tray.ps1"' },
      { pid: 17608, parentPid: 888, name: 'cmd.exe', commandLine: cmd + ' /c "' + mods + path.sep + 'uninstall.cmd"' },
      { pid: 12964, parentPid: 17608, name: 'node.exe', commandLine: '"' + node + '" "' + mods + path.sep + 'setup-wizard.js" --uninstall --dir "' + mods + '\\"' },
    ];
  }

  test('stops run-crew loops, then tray, then the server; excludes the uninstall wizard 17608 and 12964', async () => {
    const procs = beastProcs('C:\\Users\\hruba\\Projects\\claudecrew', 'C:\\Users\\hruba\\Downloads\\claudecrew-main\\claudecrew-main');
    const plan = un.planProcessStops(procs, { selfPid: 12964, selfPpid: 17608 });
    const pids = plan.planned.map((p) => p.pid);
    assert.equal(pids.includes(17608), false);
    assert.equal(pids.includes(12964), false);
    assert.ok(plan.excluded.includes(17608));
    assert.ok(plan.excluded.includes(12964));
    assert.deepEqual(pids.filter((p) => [9436, 7972, 17180, 16400, 16420].includes(p)).sort((a, b) => a - b), [7972, 9436, 16400, 16420, 17180].sort((a, b) => a - b));
    const shells = plan.planned.filter((p) => p.stopRank === 0).map((p) => p.pid).sort((a, b) => a - b);
    const trays = plan.planned.filter((p) => p.stopRank === 1).map((p) => p.pid).sort((a, b) => a - b);
    const servers = plan.planned.filter((p) => p.stopRank === 2).map((p) => p.pid);
    assert.deepEqual(shells, [7972, 17180]);
    assert.deepEqual(trays, [16400, 16420]);
    assert.deepEqual(servers, [9436]);
    const firstLoop = plan.planned.find((p) => p.stopRank === 0);
    const firstServer = plan.planned.find((p) => p.stopRank === 2);
    assert.ok(plan.planned.indexOf(firstLoop) < plan.planned.indexOf(firstServer));
    const order = plan.planned.map((p) => p.stopRank);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));

    const killed = [];
    const actions = await un.stopSelectedProcesses(procs, {
      dryRun: false,
      platform: 'win32',
      selfPid: 12964,
      selfPpid: 17608,
      run: async (file, args) => {
        killed.push({ file, args });
        return { ok: true, code: 0 };
      },
      // skip live command-line lookup
    });
    assert.ok(actions.some((a) => a.action === 'exclude' && a.pid === 17608));
    assert.ok(actions.some((a) => a.action === 'exclude' && a.pid === 12964));
    const stopPids = actions.filter((a) => a.action === 'stop').map((a) => a.pid);
    assert.equal(stopPids.includes(17608), false);
    assert.equal(stopPids.includes(12964), false);
    const kills = killed.filter((k) => k.file === 'taskkill');
    assert.ok(kills.length >= 1);
    assert.ok(kills.every((k) => k.args[0] === '/PID' && k.args[2] === '/T'));
    assert.equal(kills.some((k) => /\/IM/i.test(k.args.join(' '))), false);
    const still = un.stillRunningFromScan({
      groups: {
        processes: procs.filter((p) => p.kind !== 'tray'),
        tray: procs.filter((p) => p.kind === 'tray'),
      },
    }, { excludedPids: plan.excluded, stoppedPids: stopPids });
    assert.equal(still.some((p) => p.pid === 17608 || p.pid === 12964), false);
  });
});

describe('backup write, inspect, restore', () => {
  function seedInstall(dir) {
    fs.mkdirSync(path.join(dir, 'data', 'summaries'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'workspace', 'assistant'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'crew.config.json'), JSON.stringify({
      settings: { port: 7777, userName: 'Jonathan', mysteryFlag: true },
      agents: [{ id: 'assistant', name: 'Assistant', cwd: 'workspace/assistant', extraField: 1 }],
    }));
    fs.writeFileSync(path.join(dir, 'data', 'state.json'), '{"ok":1}');
    fs.writeFileSync(path.join(dir, 'data', 'summaries', 'today.md'), 'notes');
    fs.writeFileSync(path.join(dir, 'workspace', 'assistant', 'notes.txt'), 'work');
    fs.writeFileSync(path.join(dir, 'install-log.txt'), 'installed');
    fs.writeFileSync(path.join(dir, 'data', 'vapid.json'), '{"k":"secret"}');
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=1');
    fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'secrets', 'token.txt'), 'nope');
    return dir;
  }

  test('new backup includes data/, summaries and workspaces, writes a manifest, and reports counts without silently skipping', async () => {
    const home = tmp();
    const install = seedInstall(path.join(home, 'ClaudeCrew'));
    const dest = path.join(home, 'ClaudeCrew-backup-20261123-100852.zip');
    const userData = un.userDataPaths(install);
    const logs = [];
    const result = await backup.writeBackup({
      userData: userData.map((u) => ({ ...u, installDir: install })),
      dest,
      log: (l) => logs.push(l),
    });
    assert.equal(result.ok, true);
    assert.ok(result.counts.files >= 4);
    assert.ok(result.counts.kinds['data/'] >= 1);
    assert.ok(result.counts.kinds.summaries >= 1);
    assert.ok(result.counts.kinds.workspace >= 1);
    assert.ok(result.counts.kinds['crew.config.json'] >= 1);
    assert.ok(result.skipped.some((s) => /vapid|\.env|secrets/.test(s.rel)));
    const info = backup.inspectBackup(dest);
    assert.ok(info.manifest);
    assert.equal(info.manifest.version, 1);
    assert.ok(info.manifest.fileCount >= 4);
    assert.ok(info.manifest.sourceDirs.some((d) => path.resolve(d) === path.resolve(install)));
    assert.ok(info.items.every((i) => i.name !== '.env' && !i.name.startsWith('secrets/')));
    assert.ok(logs.some((l) => /Backup wrote/.test(l)));
    assert.ok(fs.statSync(dest).size > 0);
  });

  test('legacy backup without a manifest is inferred and unknown config keys are warned', async () => {
    const home = tmp();
    // Round-1 / 7,980-byte layout: files at the zip root (createBackupZip, single folder).
    const dest = path.join(home, 'legacy-backup.zip');
    zip.createZip(dest, [
      { name: 'crew.config.json', data: JSON.stringify({ settings: { port: 7777, userName: 'You', weird: 1 }, agents: [{ id: 'assistant', cwd: 'workspace/assistant' }] }) },
      { name: 'data/state.json', data: '{"ok":true}' },
      { name: 'data/summaries/old.md', data: 'sum' },
      { name: 'workspace/assistant/notes.txt', data: 'ws' },
      { name: 'install-log.txt', data: 'log' },
    ]);
    const info = backup.inspectBackup(dest);
    assert.equal(info.manifest, null);
    assert.equal(info.layout.kind, 'single');
    assert.ok(info.warnings.some((w) => /without a manifest/i.test(w)));
    const install = path.join(home, 'ClaudeCrew');
    fs.mkdirSync(install, { recursive: true });
    const preview = backup.previewRestore(dest, install);
    assert.ok(preview.warnings.some((w) => /Unknown settings key: weird/.test(w)));
    const result = await backup.restoreBackup({ file: dest, destDir: install, mode: 'replace', confirmReplace: true, env: { HOME: home, USERPROFILE: home }, homedir: home });
    assert.equal(result.ok, true);
    const cfg = JSON.parse(fs.readFileSync(path.join(install, 'crew.config.json'), 'utf8'));
    assert.equal(cfg.settings.port, 7777);
    assert.equal(cfg.settings.weird, undefined);
    assert.ok(fs.existsSync(path.join(install, 'data', 'summaries', 'old.md')));
    assert.ok(fs.existsSync(path.join(install, 'workspace', 'assistant', 'notes.txt')));
  });

  test('zip-slip cases are rejected', () => {
    const home = tmp();
    const dest = path.join(home, 'evil.zip');
    for (const name of ['../outside.txt', '/tmp/abs.txt', 'C:\\\\Windows\\\\system32\\\\x.dll', '\\\\server\\\\share\\\\x', 'ok/../../etc/passwd']) {
      zip.createZip(dest, [{ name, data: 'hack' }]);
      assert.throws(() => backup.inspectBackup(dest), /safety|absolute|traversal|drive|UNC/i);
    }
  });

  test('conflict handling: merge keeps existing, replace backs up then overwrites, cancel does nothing', async () => {
    const home = tmp();
    const install = path.join(home, 'ClaudeCrew');
    fs.mkdirSync(path.join(install, 'data'), { recursive: true });
    fs.writeFileSync(path.join(install, 'crew.config.json'), '{"settings":{"port":1}}');
    fs.writeFileSync(path.join(install, 'data', 'state.json'), 'old');
    const dest = path.join(home, 'ClaudeCrew-backup-test.zip');
    zip.createZip(dest, [
      { name: 'manifest.json', data: JSON.stringify({ version: 1, kind: 'claude-crew-backup', date: '2026-11-23T15:08:52.000Z', sourceDirs: [install], fileCount: 2 }) },
      { name: 'crew.config.json', data: '{"settings":{"port":7777}}' },
      { name: 'data/state.json', data: 'new' },
    ]);
    const preview = backup.previewRestore(dest, install);
    assert.equal(preview.conflicts.length, 2);
    const cancelled = await backup.restoreBackup({ file: dest, destDir: install, mode: 'cancel' });
    assert.equal(cancelled.cancelled, true);
    assert.equal(fs.readFileSync(path.join(install, 'data', 'state.json'), 'utf8'), 'old');
    const merge = await backup.restoreBackup({ file: dest, destDir: install, mode: 'merge', env: { HOME: home, USERPROFILE: home }, homedir: home });
    assert.equal(merge.ok, true);
    assert.equal(fs.readFileSync(path.join(install, 'data', 'state.json'), 'utf8'), 'old');
    const needs = await backup.restoreBackup({ file: dest, destDir: install, mode: 'replace', confirmReplace: false });
    assert.equal(needs.needsConfirm, true);
    const replaced = await backup.restoreBackup({ file: dest, destDir: install, mode: 'replace', confirmReplace: true, env: { HOME: home, USERPROFILE: home }, homedir: home });
    assert.equal(replaced.ok, true);
    assert.ok(replaced.safetyBackup && replaced.safetyBackup.path);
    assert.ok(fs.existsSync(replaced.safetyBackup.path));
    assert.equal(fs.readFileSync(path.join(install, 'data', 'state.json'), 'utf8'), 'new');
    const cfg = JSON.parse(fs.readFileSync(path.join(install, 'crew.config.json'), 'utf8'));
    assert.equal(cfg.settings.port, 7777);
  });

  test('secret entries are skipped and listed, never restored', async () => {
    const home = tmp();
    const install = path.join(home, 'ClaudeCrew');
    fs.mkdirSync(install, { recursive: true });
    const dest = path.join(home, 'with-secrets.zip');
    zip.createZip(dest, [
      { name: 'crew.config.json', data: '{"settings":{"port":7777}}' },
      { name: '.env', data: 'SECRET=1' },
      { name: '.env.local', data: 'SECRET=2' },
      { name: 'secrets/token.txt', data: 'nope' },
      { name: 'data/vapid.json', data: '{"k":1}' },
      { name: 'data/state.json', data: '{}' },
    ]);
    const result = await backup.restoreBackup({ file: dest, destDir: install, mode: 'replace', confirmReplace: true, env: { HOME: home, USERPROFILE: home }, homedir: home });
    assert.equal(result.ok, true);
    assert.ok(result.secretsSkipped.some((n) => n === '.env'));
    assert.ok(result.secretsSkipped.some((n) => n === '.env.local'));
    assert.ok(result.secretsSkipped.some((n) => n === 'secrets/token.txt'));
    assert.ok(result.secretsSkipped.some((n) => n === 'data/vapid.json'));
    assert.equal(fs.existsSync(path.join(install, '.env')), false);
    assert.equal(fs.existsSync(path.join(install, 'secrets', 'token.txt')), false);
    assert.equal(fs.existsSync(path.join(install, 'data', 'vapid.json')), false);
    assert.equal(fs.existsSync(path.join(install, 'data', 'state.json')), true);
  });

  test('findBackupZips lists %USERPROFILE% ClaudeCrew-backup-*.zip newest first', () => {
    const home = tmp();
    const older = path.join(home, 'ClaudeCrew-backup-20261123-100852.zip');
    const newer = path.join(home, 'ClaudeCrew-backup-20261123-110000.zip');
    zip.createZip(older, [{ name: 'crew.config.json', data: '{}' }]);
    zip.createZip(newer, [{ name: 'crew.config.json', data: '{}' }]);
    const found = backup.findBackupZips({ env: { USERPROFILE: home, HOME: home }, homedir: home });
    assert.ok(found.length >= 2);
    assert.equal(found[0].name, 'ClaudeCrew-backup-20261123-110000.zip');
  });
});
