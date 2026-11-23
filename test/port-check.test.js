'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const portCheck = require('../lib/port-check');
const backoff = require('../lib/backoff');

describe('readConfiguredPort', () => {
  test('defaults to 7777, honours CREW_PORT, then crew.config.json', () => {
    assert.equal(portCheck.readConfiguredPort({ dir: '/tmp/missing-crew-port', env: {}, exists: () => false }), 7777);
    assert.equal(portCheck.readConfiguredPort({ env: { CREW_PORT: '18788' }, exists: () => false }), 18788);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-port-'));
    fs.writeFileSync(path.join(dir, 'crew.config.json'), JSON.stringify({ settings: { port: 12345 } }));
    assert.equal(portCheck.readConfiguredPort({ dir, env: {}, readFile: fs.readFileSync, exists: fs.existsSync }), 12345);
    assert.equal(portCheck.readConfiguredPort({ dir, env: { CREW_PORT: '9999' }, readFile: fs.readFileSync, exists: fs.existsSync }), 9999);
  });
});

describe('isCrewListening', () => {
  test('is true only when a Crew endpoint answers, not a random HTTP server', async () => {
    const calls = [];
    const get = async (url) => {
      calls.push(url);
      if (url.endsWith('/api/update')) return { status: 200, body: JSON.stringify({ current: '0.6.1', available: false }) };
      return { status: 404, body: '{}' };
    };
    assert.equal(await portCheck.isCrewListening({ port: 7777, get }), true);
    assert.ok(calls.some((u) => u.includes('127.0.0.1:7777/api/update')));

    const other = async (url) => {
      if (url.endsWith('/api/update')) return { status: 200, body: '<html>not crew</html>' };
      if (url.endsWith('/api/machines/link')) return { status: 200, body: JSON.stringify({ hello: true }) };
      return { status: 200, body: '{}' };
    };
    assert.equal(await portCheck.isCrewListening({ port: 80, get: other }), false);

    const linkOnly = async (url) => {
      if (url.endsWith('/api/update')) throw new Error('down');
      return { status: 200, body: JSON.stringify({ url: '' }) };
    };
    assert.equal(await portCheck.isCrewListening({ port: 7777, get: linkOnly }), true);

    const refused = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal(await portCheck.isCrewListening({ port: 7777, get: refused }), false);
  });

  test('alreadyRunningMessage uses the configured port and never implies a kill', async () => {
    const r = await portCheck.alreadyRunningMessage({
      env: { CREW_PORT: '5555' },
      exists: () => false,
      get: async () => ({ status: 200, body: JSON.stringify({ current: '0.6.1' }) }),
    });
    assert.equal(r.running, true);
    assert.equal(r.port, 5555);
    assert.equal(r.message, 'Crew already running on port 5555, not starting another copy');
    assert.ok(!/kill|taskkill|stop-process/i.test(r.message));
  });
});

describe('restart backoff', () => {
  test('quick crashes wait 10s, then 30s, then 60s, capped at five minutes; a long run resets', () => {
    let s = {};
    s = backoff.nextBackoff(s, { ranMs: 1000 });
    assert.deepEqual({ fails: s.fails, wait: s.wait, quick: s.quick }, { fails: 1, wait: 10, quick: true });
    s = backoff.nextBackoff(s, { ranMs: 1000 });
    assert.equal(s.wait, 30);
    s = backoff.nextBackoff(s, { ranMs: 2000 });
    assert.equal(s.wait, 60);
    s = backoff.nextBackoff(s, { ranMs: 2000 });
    assert.equal(s.wait, 120);
    s = backoff.nextBackoff(s, { ranMs: 2000 });
    assert.equal(s.wait, 240);
    s = backoff.nextBackoff(s, { ranMs: 2000 });
    assert.equal(s.wait, 300);
    s = backoff.nextBackoff(s, { ranMs: 2000 });
    assert.equal(s.wait, 300);
    s = backoff.nextBackoff(s, { ranMs: 60 * 1000 });
    assert.equal(s.wait, 10);
    assert.equal(s.fails, 0);
    assert.equal(s.reset, true);
    assert.match(backoff.formatBackoffLog({ wait: 30, quick: true, fails: 2, code: 1 }), /Quick crash #2; restarting in 30 seconds/);
  });
});

describe('run-crew.cmd does not use timeout', () => {
  test('waits with ping and checks the port before starting', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'run-crew.cmd'), 'utf8');
    const cmds = src.split(/\r?\n/).filter((l) => l && !/^\s*(rem\b|::)/i.test(l));
    assert.equal(cmds.some((l) => /\btimeout\s+\/t\b/i.test(l)), false);
    assert.match(src, /Do not use `timeout`/);
    assert.match(src, /ping -n/);
    assert.match(src, /crew-port-check\.js/);
    assert.match(src, /crew-backoff\.js/);
    assert.match(src, /already answering on its port/);
    assert.match(src, /exit \/b 0/);
  });
});

describe('run-crew.cmd stop flag and single-instance lock', () => {
  test('checks crew.stop before restarting and acquires a launcher lock', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'run-crew.cmd'), 'utf8');
    const cmds = src.split(/\r?\n/).filter((l) => l && !/^\s*(rem\b|::)/i.test(l));
    assert.equal(cmds.some((l) => /\btimeout\s+\/t\b/i.test(l)), false);
    assert.match(src, /crew\.stop/);
    assert.match(src, /data\\crew\.stop/);
    assert.match(src, /stop flag present, not starting/);
    assert.match(src, /crew-launcher-lock\.js/);
    assert.match(src, /errorlevel 2/);
  });
});
