#!/usr/bin/env node
'use strict';
// Exit 0 if this launcher acquired the lock, 2 if another live run-crew.cmd
// already holds it, 1 on error. Never kills anything. Prints a one-line message.
const lock = require('../lib/launcher-lock');

(async () => {
  const dir = process.cwd();
  const pid = Number(process.ppid) || process.pid;
  const result = await lock.acquireLauncherLock(dir, { pid, dir });
  if (result.message) process.stdout.write(result.message + '\n');
  if (result.alreadyRunning) process.exit(2);
  if (!result.ok) {
    if (result.error) process.stderr.write(result.error + '\n');
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  process.stderr.write((err && err.message) || String(err) + '\n');
  process.exit(1);
});
