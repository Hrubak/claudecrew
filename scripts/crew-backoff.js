#!/usr/bin/env node
'use strict';
// After server.js exits, print the number of seconds to wait before restarting.
// State is stored in data/crew.restart.json. Stdout is the number only.
const fs = require('fs');
const path = require('path');
const { STATE_NAME, nextBackoff, formatBackoffLog } = require('../lib/backoff');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const startedAt = Number(arg('started-at', '0'));
const code = arg('code', '?');
const now = Date.now();
const ranMs = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
const file = path.join(process.cwd(), 'data', STATE_NAME);
let prev = {};
try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
const next = nextBackoff(prev, { ranMs });
const out = {
  fails: next.fails,
  wait: next.wait,
  lastExit: code,
  lastRanMs: ranMs,
  lastAt: new Date(now).toISOString(),
};
try {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out) + '\n');
} catch { /* still print a wait */ }
process.stderr.write(formatBackoffLog({ ...next, code }) + '\n');
process.stdout.write(String(next.wait));
