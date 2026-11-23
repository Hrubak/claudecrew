#!/usr/bin/env node
'use strict';
// Read-only Claude Crew scanner. Lists installs and leftovers. Changes nothing:
// no process stop, no file delete, no registry write, no scheduled-task change.
const path = require('path');
const { scanCrew } = require('../lib/scan');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: node scripts/crew-scan.js [--json]\nRead-only. Prints findings and exits. Does not change the system.\n');
    process.exit(0);
  }
  const asJson = args.includes('--json');
  const scriptPath = path.join(__dirname, '..', 'scan-inventory.ps1');
  const result = await scanCrew({
    currentDir: path.resolve(__dirname, '..'),
    scriptPath,
  });
  result.readOnly = true;
  result.changedNothing = true;
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const g = result.groups;
    const count = result.items.length;
    process.stdout.write('Claude Crew scan (read-only, nothing was changed)\n');
    process.stdout.write('Found ' + count + ' item(s)\n\n');
    const show = (title, list, line) => {
      process.stdout.write(title + ' (' + list.length + ')\n');
      for (const it of list) process.stdout.write('  ' + line(it) + '\n');
      process.stdout.write('\n');
    };
    show('Folders', g.folders, (i) => i.path + '  [' + (i.markers || []).join(', ') + ']' + (i.defaultChecked ? '' : '  (unchecked by default)'));
    show('Processes', g.processes, (i) => 'PID ' + i.pid + ' ' + i.name + '  ' + (i.reason || ''));
    show('Tray', g.tray, (i) => 'PID ' + i.pid + '  ' + (i.commandLine || ''));
    show('Shortcuts', g.shortcuts, (i) => i.path + ' -> ' + i.target);
    show('Scheduled tasks', g.scheduledTasks, (i) => i.name);
    show('Run / RunOnce keys', g.runKeys, (i) => i.hive + ' ' + i.name + (i.readOnly ? '  (HKLM, read-only check)' : ''));
  }
}

main().catch((err) => {
  process.stderr.write(String(err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
