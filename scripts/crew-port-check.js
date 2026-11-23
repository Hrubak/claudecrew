#!/usr/bin/env node
'use strict';
// Exit 0 if Crew is already answering on its configured port; exit 1 otherwise.
// Prints a one-line message when it is running. Never kills anything.
const { alreadyRunningMessage } = require('../lib/port-check');

(async () => {
  const result = await alreadyRunningMessage({ dir: process.cwd(), env: process.env });
  if (result.message) process.stdout.write(result.message + '\n');
  process.exit(result.running ? 0 : 1);
})().catch(() => process.exit(1));
