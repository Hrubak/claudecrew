'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const setup = require('../lib/setup');

const PLATFORM = 'win32';
const HOME = 'C:\\Users\\hruba';
const DIR = path.win32.join(HOME, '.local', 'bin');
const EXE = path.win32.join(DIR, 'claude.exe');

function mockRun(state) {
  state.calls = state.calls || [];
  return async (file, args, opts = {}) => {
    const command = Array.isArray(args) ? args[args.length - 1] : '';
    state.calls.push({ file, args, opts, command });
    assert.notEqual(file, 'setx');
    assert.ok(!(args || []).some((a) => String(a).toLowerCase().startsWith('setx') || String(a) === 'setx'));
    if (file === 'powershell.exe' && args.includes(setup.GET_USER_PATH_PS)) {
      return { ok: state.readOk !== false, stdout: state.userPath == null ? '' : state.userPath, stderr: state.readErr || '' };
    }
    if (file === 'powershell.exe' && args.includes(setup.SET_USER_PATH_PS)) {
      if (state.writeOk === false) return { ok: false, stdout: '', stderr: state.writeErr || 'access denied' };
      state.userPath = opts.env && opts.env.CREW_SET_USER_PATH;
      state.writes = (state.writes || []).concat([state.userPath]);
      return { ok: true, stdout: '', stderr: '' };
    }
    if (args && args.includes('--version')) {
      const fromPath = file === 'claude' || file === 'claude.exe';
      if (fromPath && state.versionOnPath) return { ok: true, stdout: state.versionOnPath, stderr: '' };
      if (file === EXE && state.versionAtFull) return { ok: true, stdout: state.versionAtFull, stderr: '' };
      return { ok: false, stdout: '', stderr: 'not found' };
    }
    if (file === 'node' && args && args[0] === '--version') return { ok: true, stdout: 'v22.11.0', stderr: '' };
    if (file === 'git' && args && args[0] === '--version') return { ok: true, stdout: 'git version 2.45.1', stderr: '' };
    return { ok: false, stdout: '', stderr: 'unexpected ' + file };
  };
}

describe('user PATH matching', () => {
  test('detects a missing folder and does not treat an empty User PATH as a match', () => {
    assert.equal(setup.userPathHasDir('', DIR), false);
    assert.equal(setup.userPathHasDir(null, DIR), false);
    assert.equal(setup.userPathHasDir('C:\\Windows;C:\\Windows\\System32', DIR), false);
    const empty = setup.withDirOnUserPath('', DIR);
    assert.equal(empty.changed, true);
    assert.equal(empty.value, DIR);
    assert.ok(!empty.value.startsWith(';'));
    assert.ok(!empty.value.endsWith(';'));
    const fromNull = setup.withDirOnUserPath(null, DIR);
    assert.equal(fromNull.value, DIR);
  });

  test('does not duplicate an existing entry', () => {
    const cur = 'C:\\Windows;' + DIR + ';C:\\Windows\\System32';
    assert.equal(setup.userPathHasDir(cur, DIR), true);
    const next = setup.withDirOnUserPath(cur, DIR);
    assert.equal(next.changed, false);
    assert.equal(next.value, cur);
  });

  test('matches User PATH entries case-insensitively', () => {
    const cur = 'C:\\Windows;c:\\users\\hruba\\.local\\bin;C:\\Windows\\System32';
    assert.equal(setup.userPathHasDir(cur, DIR), true);
    assert.equal(setup.userPathHasDir(cur, 'C:\\USERS\\HRUBA\\.LOCAL\\BIN'), true);
    assert.equal(setup.withDirOnUserPath(cur, DIR).changed, false);
  });

  test('matches trailing-backslash and mixed-slash variants', () => {
    const variants = [
      DIR + '\\',
      DIR + '\\\\',
      'C:/Users/hruba/.local/bin',
      'C:/Users/hruba/.local/bin/',
      '"' + DIR + '"',
      '"' + DIR + '\\"',
    ];
    for (const entry of variants) {
      assert.equal(setup.userPathHasDir(entry, DIR), true, 'should match ' + entry);
      assert.equal(setup.withDirOnUserPath(entry, DIR).changed, false, 'no dup for ' + entry);
    }
    const mixed = 'C:\\Windows;C:/Users/hruba/.local/bin/;C:\\Windows\\System32';
    assert.equal(setup.userPathHasDir(mixed, DIR + '\\'), true);
    assert.equal(setup.withDirOnUserPath(mixed, DIR).changed, false);
  });
});

describe('ensureLocalClaudePath', () => {
  test('adds the folder to an empty User PATH, prepends the process PATH, and never calls setx', async () => {
    const env = { USERPROFILE: HOME, PATH: 'C:\\Windows' };
    const state = { userPath: '' };
    const result = await setup.ensureLocalClaudePath({
      platform: PLATFORM,
      env,
      run: mockRun(state),
      exists: (p) => p === EXE,
    });
    assert.equal(result.ok, true);
    assert.equal(result.fixed, true);
    assert.equal(result.needed, true);
    assert.equal(result.dir, DIR);
    assert.equal(state.userPath, DIR);
    assert.equal((state.writes || []).length, 1);
    assert.ok(env.PATH.startsWith(DIR + ';'));
    assert.ok(env.Path.startsWith(DIR + ';'));
    assert.match(result.message, /Added C:\\Users\\hruba\\.local\\bin to your PATH\. Open new terminals to pick it up\./);
    assert.ok(state.calls.every((c) => c.file === 'powershell.exe'));
    assert.ok(state.calls.some((c) => c.command === setup.GET_USER_PATH_PS));
    assert.ok(state.calls.some((c) => c.command === setup.SET_USER_PATH_PS));
    assert.equal(state.calls.filter((c) => c.command === setup.SET_USER_PATH_PS)[0].opts.env.CREW_SET_USER_PATH, DIR);
  });

  test('does not write when the folder is already on the User PATH (including case and trailing slash)', async () => {
    const env = { USERPROFILE: HOME, PATH: 'C:\\Windows' };
    const state = { userPath: 'C:\\Windows;c:\\users\\hruba\\.local\\bin\\' };
    const result = await setup.ensureLocalClaudePath({
      platform: PLATFORM,
      env,
      run: mockRun(state),
      exists: (p) => p === EXE,
    });
    assert.equal(result.ok, true);
    assert.equal(result.needed, false);
    assert.equal(result.alreadyOnUserPath, true);
    assert.equal(result.fixed, undefined);
    assert.equal(state.writes, undefined);
    assert.ok(env.PATH.startsWith(DIR + ';'), 'process PATH is still prepended so Sign in works now');
  });

  test('does nothing when claude.exe is not present', async () => {
    const env = { USERPROFILE: HOME, PATH: 'C:\\Windows' };
    const state = { userPath: '' };
    const result = await setup.ensureLocalClaudePath({
      platform: PLATFORM,
      env,
      run: mockRun(state),
      exists: () => false,
    });
    assert.equal(result.needed, false);
    assert.equal(result.exeExists, false);
    assert.equal(state.writes, undefined);
    assert.equal(state.calls.length, 0);
    assert.equal(env.PATH, 'C:\\Windows');
  });

  test('skips User PATH writes off Windows', async () => {
    const env = { USERPROFILE: HOME, PATH: '/usr/bin' };
    const state = { userPath: '' };
    const result = await setup.ensureLocalClaudePath({
      platform: 'linux',
      env,
      run: mockRun(state),
      exists: () => true,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.needed, false);
    assert.equal(state.calls.length, 0);
  });

  test('returns manual steps and does not claim success when the write fails', async () => {
    const env = { USERPROFILE: HOME, PATH: 'C:\\Windows' };
    const state = { userPath: 'C:\\Windows', writeOk: false, writeErr: 'access denied' };
    const result = await setup.ensureLocalClaudePath({
      platform: PLATFORM,
      env,
      run: mockRun(state),
      exists: (p) => p === EXE,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed, true);
    assert.equal(result.fixed, undefined);
    assert.match(result.message, /Could not add/);
    assert.match(result.manualSteps, /SetEnvironmentVariable/);
    assert.match(result.manualSteps, /Do not use setx/);
    assert.ok(!result.manualSteps.toLowerCase().includes('setx') || result.manualSteps.includes('Do not use setx'));
    assert.ok(env.PATH.startsWith(DIR + ';'), 'process PATH is still prepended');
  });
});

describe('claude version re-check and Sign in path', () => {
  test('checkPrereqs uses the full claude.exe path when `claude` is not on PATH yet', async () => {
    const env = { USERPROFILE: HOME, PATH: 'C:\\Windows' };
    const state = { userPath: '', versionAtFull: '1.2.3 (Claude Code)' };
    const run = mockRun(state);
    const prereqs = await setup.checkPrereqs({
      platform: PLATFORM,
      env,
      run,
      exists: (p) => p === EXE,
    });
    assert.equal(prereqs.pathFix.fixed, true);
    assert.equal(prereqs.claude.ok, true);
    assert.match(prereqs.claude.text, /1\.2\.3/);
    assert.equal(prereqs.commands.login.args.includes(EXE), true);
    const versionCalls = state.calls.filter((c) => (c.args || []).includes('--version'));
    assert.ok(versionCalls.some((c) => c.file === EXE));
  });

  test('Sign in launches the full claude.exe path when it exists', () => {
    const env = { USERPROFILE: HOME, PATH: DIR + ';C:\\Windows' };
    const calls = [];
    const launched = setup.launchClaudeLogin({
      platform: PLATFORM,
      env,
      exists: (p) => p === EXE,
      spawnFn: (file, args, opts) => {
        calls.push({ file, args, opts });
        return { pid: 9, unref() {} };
      },
    });
    assert.equal(launched.ok, true);
    assert.deepEqual(launched.spec.args, ['/c', 'start', '', 'cmd.exe', '/k', EXE]);
    assert.match(launched.spec.commandText, /claude\.exe/);
    assert.equal(calls[0].args[calls[0].args.length - 1], EXE);
  });
});
