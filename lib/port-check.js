'use strict';
// Detect whether a Claude Crew server is already answering on a port.
// Never kills a process. Used by run-crew.cmd to avoid starting a second copy.
const fs = require('fs');
const http = require('http');
const path = require('path');

function readConfiguredPort({ dir = process.cwd(), env = process.env, readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  const fromEnv = Number(env && env.CREW_PORT);
  if (fromEnv > 0) return fromEnv;
  const cfgPath = path.join(dir, 'crew.config.json');
  if (exists(cfgPath)) {
    try {
      const cfg = JSON.parse(readFile(cfgPath, 'utf8'));
      const n = Number(cfg && cfg.settings && cfg.settings.port);
      if (n > 0) return n;
    } catch { /* ignore a broken config and fall through */ }
  }
  return 7777;
}

function looksLikeCrewUpdate(body) {
  return !!(body && typeof body === 'object' && typeof body.current === 'string');
}

function looksLikeCrewLink(body) {
  return !!(body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'url'));
}

function defaultGet(url, { timeout = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

async function isCrewListening({
  port,
  host = '127.0.0.1',
  get = defaultGet,
  timeout = 1500,
} = {}) {
  const p = Number(port);
  if (!p) return false;
  const paths = [
    { path: '/api/update', test: looksLikeCrewUpdate },
    { path: '/api/machines/link', test: looksLikeCrewLink },
  ];
  for (const item of paths) {
    try {
      const r = await get('http://' + host + ':' + p + item.path, { timeout });
      if (r && r.status === 200 && item.test(parseJson(r.body))) return true;
    } catch { /* not Crew, or nothing is listening */ }
  }
  return false;
}

async function alreadyRunningMessage(opts = {}) {
  const port = opts.port != null ? Number(opts.port) : readConfiguredPort(opts);
  const ok = await isCrewListening({ ...opts, port });
  if (ok) return { running: true, port, message: 'Crew already running on port ' + port + ', not starting another copy' };
  return { running: false, port, message: '' };
}

module.exports = {
  readConfiguredPort, looksLikeCrewUpdate, looksLikeCrewLink, isCrewListening, alreadyRunningMessage,
};
