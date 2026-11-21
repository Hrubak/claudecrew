'use strict';
// Shared "judge": one cheap, one-shot Claude call that other features can use to
// classify or score something (e.g. pick a model for a job). It is OFF by default and
// only runs when settings.judge.enabled is true. Nothing in Crew calls it automatically;
// it is reachable only through the manual POST /api/judge endpoint.

function createJudge({ getSettings, launch, env, cwd, timeoutMs = 60000 }) {
  function ask(prompt) {
    const cfg = getSettings().judge || {};
    if (!cfg.enabled) return Promise.resolve({ ok: false, disabled: true, error: 'The judge is switched off. Turn it on in Settings > Routing.' });
    prompt = String(prompt || '').trim();
    if (!prompt) return Promise.resolve({ ok: false, error: 'Empty prompt.' });
    return new Promise((resolve) => {
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--model', cfg.model || 'haiku', '--effort', 'low',
        '--disallowedTools', 'Agent,Task,Bash,Edit,Write', '--permission-prompts', 'none'];
      let proc;
      try { proc = launch(args, { cwd, env: env(), windowsHide: true }); } catch (e) { return resolve({ ok: false, error: e.message }); }
      let out = '', err = '', done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } finish({ ok: false, error: 'Judge timed out.' }); }, timeoutMs);
      proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', (d) => { err += d; });
      proc.on('error', (e) => finish({ ok: false, error: e.message }));
      proc.on('close', (code) => {
        try {
          const j = JSON.parse(out);
          if (j.is_error) return finish({ ok: false, error: String(j.result || 'Judge failed.') });
          finish({ ok: true, text: String(j.result || ''), model: cfg.model || 'haiku', costUSD: j.total_cost_usd ?? null });
        } catch {
          finish({ ok: false, error: err.trim() || `Judge exited with code ${code}.` });
        }
      });
      proc.stdin.on('error', () => {});
      proc.stdin.end(prompt);
    });
  }
  return { ask };
}

module.exports = { createJudge };
