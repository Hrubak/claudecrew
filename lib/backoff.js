'use strict';
// Restart backoff for run-crew.cmd. Quick crashes wait 10s, then 30s, then 60s,
// doubling after that up to 5 minutes. A run that lasted a minute or more resets.
const WAITS = [10, 30, 60, 120, 240, 300];
const QUICK_MS = 60 * 1000;
const STATE_NAME = 'crew.restart.json';

function nextBackoff(state, { ranMs } = {}) {
  const prev = state && typeof state === 'object' ? state : {};
  if (Number(ranMs) >= QUICK_MS) {
    return { fails: 0, wait: WAITS[0], quick: false, reset: true };
  }
  const fails = (Number(prev.fails) || 0) + 1;
  const wait = WAITS[Math.min(fails - 1, WAITS.length - 1)];
  return { fails, wait, quick: true, reset: false };
}

function formatBackoffLog({ wait, quick, fails, reset, code }) {
  if (reset) return 'Crew ran long enough; restarting in ' + wait + ' seconds (exit ' + code + ').';
  return 'Quick crash #' + fails + '; restarting in ' + wait + ' seconds (exit ' + (code == null ? '?' : code) + ').';
}

module.exports = { WAITS, QUICK_MS, STATE_NAME, nextBackoff, formatBackoffLog };
