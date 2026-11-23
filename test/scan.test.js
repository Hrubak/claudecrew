'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const scan = require('../lib/scan');
const uninstall = require('../lib/uninstall');

const HOME_ROOT = '/workspace/claudecrew-design/.testhomes';
function tmp() {
  fs.mkdirSync(HOME_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(HOME_ROOT, 's-'));
}
function stubCrew(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), '// crew\n');
  fs.writeFileSync(path.join(dir, 'crew-tray.ps1'), '# tray\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-crew' }));
  fs.writeFileSync(path.join(dir, 'Start Crew.bat'), 'rem\n');
  return dir;
}

describe('crew folder detection', () => {
  test('a folder is Crew when it has server.js plus Crew markers / package name', () => {
    const home = tmp();
    const dir = stubCrew(path.join(home, 'ClaudeCrew'));
    const v = scan.isCrewFolder(dir);
    assert.equal(v.ok, true);
    assert.ok(v.markers.includes('server.js'));
    assert.ok(v.markers.some((m) => m.startsWith('package.json:')));
    const other = path.join(home, 'random-app');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'server.js'), 'console.log(1)\n');
    assert.equal(scan.isCrewFolder(other).ok, false);
  });
});

describe('detection matching with mocked process, shortcut, task and registry data', () => {
  test('scanCrew finds well-known folders and matches Crew-only processes and leftovers', async () => {
    const home = tmp();
    const install = stubCrew(path.join(home, 'ClaudeCrew'));
    const zip = stubCrew(path.join(home, 'Downloads', 'claudecrew-main'));
    const projects = stubCrew(path.join(home, 'Projects', 'claudecrew'));
    const outsider = stubCrew(path.join(home, 'PublicShare', 'CrewCopy')); // still under home... put outside
    const inventory = {
      processes: [
        { pid: 11, name: 'node.exe', executablePath: path.join(install, 'runtime', 'node', 'node.exe'), commandLine: '"' + path.join(install, 'runtime', 'node', 'node.exe') + '" "' + path.join(install, 'server.js') + '"' },
        { pid: 22, name: 'powershell.exe', executablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', commandLine: 'powershell.exe -File "' + path.join(install, 'crew-tray.ps1') + '"' },
        { pid: 33, name: 'node.exe', executablePath: '/usr/bin/node', commandLine: 'node /opt/other-app/server.js' },
        { pid: 44, name: 'chrome.exe', commandLine: 'chrome' },
      ],
      shortcuts: [
        { path: path.join(home, 'Desktop', 'Claude Crew.lnk'), target: path.join(install, 'Start Crew.bat'), args: '', workdir: install },
        { path: path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Claude Crew tray.lnk'), target: 'C:\\Windows\\System32\\conhost.exe', args: '--headless powershell -File "' + path.join(install, 'crew-tray.ps1') + '"', workdir: install },
        { path: path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Claude Crew.lnk'), target: path.join(install, 'Start Crew.bat'), args: '', workdir: install },
        { path: path.join('C:', 'ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Claude Crew.lnk'), target: path.join(install, 'Start Crew.bat'), args: '', workdir: install },
        { path: path.join(home, 'Desktop', 'Notes.lnk'), target: path.join(home, 'notes.txt'), args: '', workdir: home },
      ],
      tasks: [
        { name: 'Claude Crew', path: '\\', actions: [{ execute: path.join(install, 'run-crew.cmd'), arguments: '', workingDirectory: install }] },
        { name: 'Windows Update', path: '\\Microsoft\\', actions: [{ execute: 'C:\\Windows\\System32\\svchost.exe', arguments: '', workingDirectory: '' }] },
      ],
      runKeys: [
        { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'Claude Crew', data: path.join(install, 'run-crew.cmd') },
        { hive: 'HKLM', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'Claude Crew', data: path.join(install, 'run-crew.cmd') },
        { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'OneDrive', data: 'C:\\Program Files\\OneDrive\\OneDrive.exe' },
      ],
      readOnly: true,
    };
    const result = await scan.scanCrew({
      env: { USERPROFILE: home, HOME: home },
      homedir: home,
      platform: 'linux',
      currentDir: install,
      inventory,
    });
    assert.equal(result.readOnly, true);
    const folders = result.groups.folders.map((f) => f.path).sort();
    assert.ok(folders.includes(path.resolve(install)));
    assert.ok(folders.includes(path.resolve(zip)));
    assert.ok(folders.includes(path.resolve(projects)));
    const pids = result.groups.processes.map((p) => p.pid);
    assert.deepEqual(pids.sort(), [11]);
    assert.ok(result.groups.tray.some((t) => t.pid === 22));
    assert.equal(result.groups.processes.some((p) => p.pid === 22), false);
    const itemPids = result.items.filter((i) => i.pid).map((i) => i.pid);
    assert.equal(itemPids.length, new Set(itemPids).size);
    assert.ok(result.groups.shortcuts.some((s) => /Desktop/.test(s.path)));
    assert.ok(result.groups.shortcuts.some((s) => /TaskBar/.test(s.path)));
    const common = result.groups.shortcuts.find((s) => /ProgramData/.test(s.path) || /Start Menu/.test(s.path) && s.outsideProfile);
    const commonSm = result.groups.shortcuts.find((s) => /ProgramData/.test(s.path));
    assert.ok(commonSm);
    assert.equal(commonSm.defaultChecked, false);
    assert.ok(result.groups.scheduledTasks.some((t) => t.name === 'Claude Crew'));
    assert.equal(result.groups.scheduledTasks.some((t) => t.name === 'Windows Update'), false);
    const hkcu = result.groups.runKeys.find((r) => r.hive === 'HKCU' && r.name === 'Claude Crew');
    const hklm = result.groups.runKeys.find((r) => r.hive === 'HKLM');
    assert.ok(hkcu && hkcu.defaultChecked);
    assert.ok(hklm && hklm.readOnly && !hklm.defaultChecked);
    assert.equal(result.groups.runKeys.some((r) => r.name === 'OneDrive'), false);
    assert.equal(result.groups.processes.some((p) => p.pid === 33), false);
  });

  test('matchProcess requires node/powershell plus Crew command line or path, never a generic name match', () => {
    const dir = '/home/user/ClaudeCrew';
    assert.ok(scan.matchProcess({ name: 'node.exe', commandLine: 'node ' + dir + '/server.js', executablePath: dir + '/runtime/node/node.exe' }, [dir]));
    assert.equal(scan.matchProcess({ name: 'node.exe', commandLine: 'node /opt/other/server.js', executablePath: '/usr/bin/node' }, [dir]), null);
    assert.ok(scan.matchProcess({ name: 'powershell.exe', commandLine: 'powershell -File ' + dir + '/crew-tray.ps1' }, [dir]));
    assert.equal(scan.matchProcess({ name: 'chrome.exe', commandLine: 'chrome ' + dir }, [dir]), null);
  });
});


describe('Beast process table', () => {
  function beastInventory(projects, zip) {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    const conhost = 'C:\\Windows\\System32\\conhost.exe';
    const npxCli = 'C:\\Users\\hruba\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npx-cli.js';
    const npmCache = 'C:\\Users\\hruba\\AppData\\Local\\npm-cache\\_npx';
    return {
      processes: [
        { pid: 816, parentPid: 6000, name: 'node.exe', executablePath: node, commandLine: '"' + node + '" "' + npxCli + '" -y @wonderwhy-er/desktop-commander' },
        { pid: 19216, parentPid: 816, name: 'node.exe', executablePath: node, commandLine: '"' + node + '" "' + npmCache + '\\abc123\\node_modules\\@wonderwhy-er\\desktop-commander\\dist\\index.js"' },
        { pid: 7944, parentPid: 6000, name: 'node.exe', executablePath: node, commandLine: '"' + node + '" "' + npxCli + '" -y @modelcontextprotocol/server-pdf' },
        { pid: 13612, parentPid: 7944, name: 'node.exe', executablePath: node, commandLine: '"' + node + '" "' + npmCache + '\\def456\\node_modules\\@modelcontextprotocol\\server-pdf\\dist\\index.js"' },
        // Exact Beast command line: system node, relative server.js, no folder path.
        { pid: 9436, parentPid: 7972, name: 'node.exe', executablePath: node, commandLine: '"' + node + '"  server.js' },
        { pid: 7972, parentPid: 16420, name: 'cmd.exe', executablePath: cmd, commandLine: cmd + ' /c "' + projects + path.sep + 'run-crew.cmd"' },
        { pid: 17180, parentPid: 888, name: 'cmd.exe', executablePath: cmd, commandLine: cmd + ' /c "' + zip + path.sep + 'run-crew.cmd"' },
        { pid: 16400, parentPid: 888, name: 'conhost.exe', executablePath: conhost, commandLine: conhost + ' --headless ' + ps + ' -NoProfile -WindowStyle Hidden -File "' + projects + path.sep + 'crew-tray.ps1"' },
        { pid: 16420, parentPid: 16400, name: 'powershell.exe', executablePath: ps, commandLine: ps + ' -NoProfile -WindowStyle Hidden -File "' + projects + path.sep + 'crew-tray.ps1"' },
      ],
      listeners: [
        { port: 7777, address: '0.0.0.0', pid: 9436 },
      ],
      runningPids: [816, 19216, 7944, 13612, 9436, 7972, 17180, 16400, 16420, 6000, 888, 4],
      shortcuts: [],
      tasks: [],
      runKeys: [],
      readOnly: true,
    };
  }

  async function scanBeast(home, projects, zip, inventory) {
    return scan.scanCrew({
      env: { USERPROFILE: home, HOME: home },
      homedir: home,
      platform: 'linux',
      currentDir: projects,
      inventory,
    });
  }

  test('Beast table adds only node PID 9436; MCP desktop-commander and server-pdf are not matched', async () => {
    const home = tmp();
    const projects = stubCrew(path.join(home, 'Projects', 'claudecrew'));
    fs.writeFileSync(path.join(projects, 'run-crew.cmd'), 'rem\n');
    fs.writeFileSync(path.join(projects, 'crew.config.json'), JSON.stringify({ settings: { port: 7777 } }));
    const zip = stubCrew(path.join(home, 'Downloads', 'claudecrew-main', 'claudecrew-main'));
    fs.writeFileSync(path.join(zip, 'run-crew.cmd'), 'rem\n');
    const inventory = beastInventory(projects, zip);
    const result = await scanBeast(home, projects, zip, inventory);

    const nodeCandidates = [816, 19216, 7944, 13612, 9436];
    const found = result.items.filter((i) => nodeCandidates.includes(i.pid)).map((i) => i.pid).sort((a, b) => a - b);
    assert.deepEqual(found, [9436]);
    assert.equal(result.groups.processes.some((p) => p.pid === 816 || p.pid === 19216 || p.pid === 7944 || p.pid === 13612), false);

    const server = result.groups.processes.find((p) => p.pid === 9436);
    assert.ok(server);
    assert.match(server.reason, /child of a Crew helper|owns configured Crew port 7777/);

    const allPids = result.items.filter((i) => i.pid).map((i) => i.pid);
    assert.ok(allPids.includes(7972));
    assert.ok(allPids.includes(17180));
    assert.ok(allPids.includes(16400));
    assert.ok(allPids.includes(16420));
    assert.ok(allPids.includes(9436));
  });

  test('tray PIDs appear once in the scan UI groups, items, and will-delete list', async () => {
    const home = tmp();
    const projects = stubCrew(path.join(home, 'Projects', 'claudecrew'));
    fs.writeFileSync(path.join(projects, 'run-crew.cmd'), 'rem\n');
    fs.writeFileSync(path.join(projects, 'crew.config.json'), JSON.stringify({ settings: { port: 7777 } }));
    const zip = stubCrew(path.join(home, 'Downloads', 'claudecrew-main', 'claudecrew-main'));
    fs.writeFileSync(path.join(zip, 'run-crew.cmd'), 'rem\n');
    const result = await scanBeast(home, projects, zip, beastInventory(projects, zip));

    assert.equal(result.groups.processes.some((p) => p.pid === 16400 || p.pid === 16420), false);
    assert.ok(result.groups.tray.some((t) => t.pid === 16400));
    assert.ok(result.groups.tray.some((t) => t.pid === 16420));
    const itemPids = result.items.filter((i) => i.pid).map((i) => i.pid);
    assert.equal(itemPids.length, new Set(itemPids).size);
    assert.equal(itemPids.filter((p) => p === 16400).length, 1);
    assert.equal(itemPids.filter((p) => p === 16420).length, 1);

    const preview = uninstall.previewScanUninstall(result, {
      dataMode: 'backup',
      env: { USERPROFILE: home, HOME: home },
      homedir: home,
    });
    const procPids = preview.processes.map((p) => p.pid);
    assert.equal(procPids.length, new Set(procPids).size);
    assert.equal(procPids.filter((p) => p === 16400 || p === 16420).length, 2);
    const willPids = preview.willDelete.filter((d) => d.pid).map((d) => d.pid);
    assert.equal(willPids.length, new Set(willPids).size);
    assert.ok(willPids.includes(16400));
    assert.ok(willPids.includes(16420));
    assert.ok(willPids.includes(9436));
    assert.equal(willPids.filter((p) => p === 16420).length, 1);
  });

  test('MCP node child of the Crew server still does not match', async () => {
    const home = tmp();
    const projects = stubCrew(path.join(home, 'Projects', 'claudecrew'));
    fs.writeFileSync(path.join(projects, 'run-crew.cmd'), 'rem\n');
    fs.writeFileSync(path.join(projects, 'crew.config.json'), JSON.stringify({ settings: { port: 7777 } }));
    const zip = stubCrew(path.join(home, 'Downloads', 'claudecrew-main', 'claudecrew-main'));
    const inventory = beastInventory(projects, zip);
    inventory.processes = inventory.processes.map((p) => p.pid === 816 || p.pid === 7944 ? { ...p, parentPid: 9436 } : p);
    const result = await scanBeast(home, projects, zip, inventory);
    const nodeCandidates = [816, 19216, 7944, 13612, 9436];
    const found = result.items.filter((i) => nodeCandidates.includes(i.pid)).map((i) => i.pid);
    assert.deepEqual(found.sort((a, b) => a - b), [9436]);
  });

  test('orphaned node server.js that owns the configured Crew port is matched, with the reason noted', async () => {
    const home = tmp();
    const projects = stubCrew(path.join(home, 'Projects', 'claudecrew'));
    fs.writeFileSync(path.join(projects, 'crew.config.json'), JSON.stringify({ settings: { port: 7777 } }));
    const inventory = {
      processes: [
        { pid: 5555, parentPid: 9999, name: 'node.exe', executablePath: 'C:\\Program Files\\nodejs\\node.exe', commandLine: '"C:\\Program Files\\nodejs\\node.exe"  server.js' },
      ],
      listeners: [{ port: 7777, address: '0.0.0.0', pid: 5555 }],
      runningPids: [5555, 4],
      shortcuts: [],
      tasks: [],
      runKeys: [],
    };
    const result = await scanBeast(home, projects, projects, inventory);
    const server = result.groups.processes.find((p) => p.pid === 5555);
    assert.ok(server);
    assert.equal(server.reason, 'owns configured Crew port 7777 (parent process is gone)');
  });

  test('unrelated node on the Crew port without server.js, or MCP with a dead parent, is not matched', async () => {
    const home = tmp();
    const projects = stubCrew(path.join(home, 'Projects', 'claudecrew'));
    fs.writeFileSync(path.join(projects, 'crew.config.json'), JSON.stringify({ settings: { port: 7777 } }));
    const inventory = {
      processes: [
        { pid: 6666, parentPid: 9999, name: 'node.exe', executablePath: 'C:\\Program Files\\nodejs\\node.exe', commandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\hruba\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npx-cli.js -y @wonderwhy-er/desktop-commander' },
        { pid: 7770, parentPid: 9999, name: 'node.exe', executablePath: 'C:\\Program Files\\nodejs\\node.exe', commandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\other-app\\index.js' },
      ],
      listeners: [
        { port: 7777, address: '0.0.0.0', pid: 6666 },
        { port: 7777, address: '127.0.0.1', pid: 7770 },
      ],
      runningPids: [6666, 7770, 4],
      shortcuts: [],
      tasks: [],
      runKeys: [],
    };
    const result = await scanBeast(home, projects, projects, inventory);
    assert.equal(result.groups.processes.some((p) => p.pid === 6666 || p.pid === 7770), false);
  });
});

describe('uninstall guards and self-delete handoff', () => {
  test('preview and runScanUninstall keep path guards and default backup outside installs', async () => {
    const home = tmp();
    const install = stubCrew(path.join(home, 'ClaudeCrew'));
    fs.writeFileSync(path.join(install, 'crew.config.json'), '{"settings":{"port":7777},"agents":[]}');
    fs.mkdirSync(path.join(install, 'data'), { recursive: true });
    const scanResult = await scan.scanCrew({ env: { USERPROFILE: home, HOME: home }, homedir: home, platform: 'linux', currentDir: install, inventory: { processes: [], shortcuts: [], tasks: [], runKeys: [] } });
    const preview = uninstall.previewScanUninstall(scanResult, { dataMode: 'backup', env: { USERPROFILE: home, HOME: home }, homedir: home });
    assert.ok(preview.backupPath.startsWith(home));
    assert.ok(!preview.backupPath.startsWith(install + path.sep) && preview.backupPath !== install);
    assert.throws(() => uninstall.assertSafeInstallDir(home, { env: { USERPROFILE: home }, homedir: home }));
    assert.throws(() => uninstall.assertSafeInstallDir('', { env: { USERPROFILE: home }, homedir: home }));
    const dry = await uninstall.runScanUninstall({
      scanResult, dataMode: 'backup', dryRun: true, env: { USERPROFILE: home, HOME: home }, homedir: home, sourceRoot: path.join(__dirname, '..'),
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.ok(fs.existsSync(path.join(install, 'server.js')));
  });

  test('needsHandoff and copyUninstallerToTemp when the script lives inside a selected folder', () => {
    const home = tmp();
    const install = stubCrew(path.join(home, 'ClaudeCrew'));
    const repo = path.join(__dirname, '..');
    assert.equal(uninstall.needsHandoff([install], { cwd: install, scriptPath: path.join(install, 'setup-wizard.js'), execPath: '/usr/bin/node' }), true);
    assert.equal(uninstall.needsHandoff([install], { cwd: home, scriptPath: path.join(home, 'other.js'), execPath: '/usr/bin/node' }), false);
    const copied = uninstall.copyUninstallerToTemp({ sourceRoot: repo, tmpdir: home });
    assert.ok(fs.existsSync(path.join(copied.dir, 'setup-wizard.js')));
    assert.ok(fs.existsSync(path.join(copied.dir, 'lib', 'uninstall.js')));
    assert.ok(fs.existsSync(path.join(copied.dir, 'scripts', 'crew-scan.js')));
    assert.ok(copied.dir.startsWith(home));
    assert.ok(!copied.dir.startsWith(install + path.sep));
  });

  test('runScanUninstall hands off instead of deleting when running from inside the install folder', async () => {
    const home = tmp();
    const install = stubCrew(path.join(home, 'ClaudeCrew'));
    fs.writeFileSync(path.join(install, 'crew.config.json'), '{}');
    const repo = path.join(__dirname, '..');
    const scanResult = await scan.scanCrew({ env: { USERPROFILE: home, HOME: home }, homedir: home, platform: 'linux', currentDir: install, extraDirs: [install], inventory: { processes: [], shortcuts: [], tasks: [], runKeys: [] } });
    const result = await uninstall.runScanUninstall({
      scanResult,
      dataMode: 'keep',
      dryRun: false,
      env: { USERPROFILE: home, HOME: home },
      homedir: home,
      sourceRoot: repo,
      tmpdir: home,
      cwd: install,
      scriptPath: path.join(install, 'setup-wizard.js'),
      execPath: '/usr/bin/node',
    });
    assert.equal(result.handedOff, true);
    assert.ok(result.tempDir);
    assert.ok(fs.existsSync(path.join(install, 'server.js')), 'must not delete itself before handoff');
  });
});

describe('read-only scan CLI', () => {
  test('scripts/crew-scan.js exists and the file comments say it changes nothing', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'crew-scan.js'), 'utf8');
    assert.ok(/Read-only/.test(src));
    assert.ok(/Changes nothing/.test(src) || /changes nothing/.test(src));
    assert.ok(!/rmSync|unlinkSync|taskkill|Stop-Process|Remove-Item/.test(src));
  });
});
