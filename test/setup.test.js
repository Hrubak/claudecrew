'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const setup = require('../lib/setup');

const HOME_ROOT = '/workspace/claudecrew-design/.testhomes';
function tmp() {
  fs.mkdirSync(HOME_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(HOME_ROOT, 'h-'));
}

describe('source', () => {
  test('default source is hast3/claudecrew main, Hrubak is a preset', () => {
    assert.equal(setup.DEFAULT_SOURCE, 'hast3');
    assert.equal(setup.PRESETS.hast3.url, 'https://github.com/hast3/claudecrew.git');
    assert.equal(setup.PRESETS.hast3.defaultBranch, 'main');
    assert.equal(setup.PRESETS.hrubak.url, 'https://github.com/Hrubak/claudecrew.git');
    assert.equal(setup.PRESETS.hrubak.defaultBranch, 'crew-mods');
  });

  test('resolveSource accepts a custom git URL and rejects zip/archive URLs', () => {
    const s = setup.resolveSource({ kind: 'custom', url: 'https://github.com/acme/claudecrew.git', branch: 'dev' });
    assert.equal(s.url, 'https://github.com/acme/claudecrew.git');
    assert.equal(s.branch, 'dev');
    assert.throws(() => setup.resolveSource({ kind: 'custom', url: 'https://github.com/acme/claudecrew/archive/refs/heads/main.zip', branch: 'main' }));
    assert.throws(() => setup.resolveSource({ kind: 'custom', url: 'https://example.com/crew.zip', branch: 'main' }));
    assert.throws(() => setup.resolveSource({ kind: 'custom', url: 'not-a-url', branch: 'main' }));
  });

  test('listBranches and branchExists use git ls-remote (mocked)', async () => {
    const calls = [];
    const run = async (cmd, args) => {
      calls.push([cmd, ...args]);
      assert.equal(cmd, 'git');
      assert.equal(args[0], 'ls-remote');
      assert.equal(args[1], '--heads');
      if (args[3] === 'missing') return { ok: true, stdout: '', stderr: '', code: 0 };
      return { ok: true, stdout: 'abc\trefs/heads/main\ndef\trefs/heads/crew-mods\n', stderr: '', code: 0 };
    };
    const branches = await setup.listBranches('https://github.com/hast3/claudecrew.git', { run });
    assert.deepEqual(branches, ['main', 'crew-mods']);
    assert.equal(await setup.branchExists('https://github.com/hast3/claudecrew.git', 'main', { run }), true);
    assert.equal(await setup.branchExists('https://github.com/hast3/claudecrew.git', 'missing', { run }), false);
    assert.ok(calls.every((c) => c[0] === 'git' && c[1] === 'ls-remote'));
  });
});

describe('folder checks', () => {
  test('blocks Downloads and temp folders', async () => {
    const home = tmp();
    const downloads = path.join(home, 'Downloads');
    const nested = path.join(downloads, 'ClaudeCrew');
    fs.mkdirSync(nested, { recursive: true });
    const env = { HOME: home, USERPROFILE: home, TEMP: path.join(home, 'AppData', 'Local', 'Temp') };
    fs.mkdirSync(env.TEMP, { recursive: true });
    const d = await setup.checkFolder(nested, { env, homedir: home, tmpdir: env.TEMP });
    assert.equal(d.kind, 'downloads');
    assert.equal(d.block, true);
    const t = await setup.checkFolder(path.join(env.TEMP, 'ClaudeCrew'), { env, homedir: home, tmpdir: env.TEMP });
    assert.equal(t.kind, 'temp');
    assert.equal(t.block, true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('blocks a ZIP-extracted folder and warns when not empty', async () => {
    const root = tmp();
    const zip = path.join(root, 'claudecrew-main');
    fs.mkdirSync(zip);
    fs.writeFileSync(path.join(zip, 'server.js'), '// crew');
    fs.writeFileSync(path.join(zip, 'INSTALL.bat'), '@echo off');
    const z = await setup.checkFolder(zip, { env: { HOME: root, USERPROFILE: root }, homedir: root, tmpdir: path.join(root, 'tmp') });
    assert.equal(z.kind, 'zip');
    assert.equal(z.block, true);

    const messy = path.join(root, 'Projects');
    fs.mkdirSync(messy);
    fs.writeFileSync(path.join(messy, 'notes.txt'), 'hi');
    const w = await setup.checkFolder(messy, { env: { HOME: root, USERPROFILE: root }, homedir: root, tmpdir: path.join(root, 'tmp') });
    assert.equal(w.kind, 'nonempty');
    assert.equal(w.ok, true);
    assert.equal(w.block, false);
    assert.ok(w.warnings.length);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('confirms a missing folder is writable and rejects a file path', async () => {
    const root = tmp();
    const dest = path.join(root, 'ClaudeCrew');
    const ok = await setup.checkFolder(dest, { env: { HOME: root, USERPROFILE: root }, homedir: root, tmpdir: path.join(root, 'tmpx') });
    assert.equal(ok.kind, 'missing');
    assert.equal(ok.ok, true);
    assert.equal(ok.writable, true);
    const file = path.join(root, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const bad = await setup.checkFolder(file, { env: { HOME: root, USERPROFILE: root }, homedir: root, tmpdir: path.join(root, 'tmpx') });
    assert.equal(bad.kind, 'file');
    assert.equal(bad.block, true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('browse folder', () => {
  test('returns not available on non-Windows', async () => {
    const r = await setup.browseFolder({ platform: 'linux', scriptPath: '/tmp/browse-folder.ps1' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not available');
  });

  test('spawns PowerShell with -STA and argv-only path, no shell concatenation', async () => {
    const calls = [];
    const spawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const handlers = { data: [], error: [], close: [] };
      const fake = {
        stdout: { on: (ev, fn) => handlers.data.push(fn) },
        stderr: { on: (ev, fn) => {} },
        on: (ev, fn) => { handlers[ev] = handlers[ev] || []; handlers[ev].push(fn); },
        kill: () => {},
      };
      setImmediate(() => {
        handlers.data.forEach((fn) => fn('C:\\Users\\hruba\\ClaudeCrew\n'));
        (handlers.close || []).forEach((fn) => fn(0));
      });
      return fake;
    };
    const r = await setup.browseFolder({
      platform: 'win32',
      current: 'C:\\Users\\hruba\\Projects',
      scriptPath: 'C:\\app\\browse-folder.ps1',
      spawnFn,
    });
    assert.equal(r.ok, true);
    assert.equal(r.path, 'C:\\Users\\hruba\\ClaudeCrew');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'powershell.exe');
    assert.deepEqual(calls[0].args, [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\app\\browse-folder.ps1',
      '-SelectedPath', 'C:\\Users\\hruba\\Projects',
    ]);
    assert.equal(calls[0].args.join(' ').includes('C:\\Users\\hruba\\Projects &&'), false);
  });
});

describe('install manifest and config', () => {
  test('writeConfig does not overwrite an existing config, sets effort low by default', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'crew.config.example.json'), JSON.stringify({
      settings: { port: 7777, allowLan: false, userName: 'You', permissionMode: 'auto', model: null },
      agents: [{ id: 'assistant', name: 'Assistant' }],
    }));
    const first = setup.writeConfig(dir, { userName: 'Jonathan', effort: 'low', port: 7777 });
    assert.equal(first.written, true);
    const cfg = JSON.parse(fs.readFileSync(first.path, 'utf8'));
    assert.equal(cfg.settings.userName, 'Jonathan');
    assert.equal(cfg.settings.effort, 'low');
    const second = setup.writeConfig(dir, { userName: 'Other' });
    assert.equal(second.written, false);
    assert.equal(JSON.parse(fs.readFileSync(first.path, 'utf8')).settings.userName, 'Jonathan');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('detectInstall recognizes a git clone, a legacy installer, and a zip extract', () => {
    const root = tmp();
    const git = path.join(root, 'git');
    fs.mkdirSync(path.join(git, '.git'), { recursive: true });
    fs.writeFileSync(path.join(git, 'server.js'), '');
    fs.writeFileSync(path.join(git, 'crew.config.json'), '{}');
    assert.equal(setup.detectInstall(git).kind, 'git');

    const legacy = path.join(root, 'legacy');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'server.js'), '');
    fs.writeFileSync(path.join(legacy, 'INSTALL.bat'), '');
    fs.writeFileSync(path.join(legacy, 'crew.config.json'), '{}');
    assert.equal(setup.detectInstall(legacy).kind, 'legacy');

    const zip = path.join(root, 'claudecrew-main');
    fs.mkdirSync(zip);
    fs.writeFileSync(path.join(zip, 'server.js'), '');
    fs.writeFileSync(path.join(zip, 'install.ps1'), '');
    const d = setup.detectInstall(zip);
    assert.equal(d.zip, true);
    assert.equal(d.kind, 'zip');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('switch source', () => {
  test('switchSource stops on dirty files in a real repo and does not reset', async () => {
    const dir = tmp();
    const runReal = setup.execFileP;
    await runReal('git', ['init'], { cwd: dir });
    await runReal('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'nope');
    const calls = [];
    const run = async (cmd, args, opts) => {
      calls.push(args.join(' '));
      if (['reset', 'clean', 'checkout'].includes(args[0]) || args.includes('--force') || args.includes('--hard')) {
        throw new Error('destructive git command was issued: ' + args.join(' '));
      }
      return runReal(cmd, args, opts);
    };
    await assert.rejects(() => setup.switchSource(dir, { url: 'https://github.com/hast3/claudecrew.git', branch: 'main', run }), /uncommitted/);
    assert.ok(!calls.some((c) => /reset|clean --force|--hard/.test(c)));
    assert.ok(fs.existsSync(path.join(dir, 'dirty.txt')));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
