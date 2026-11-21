'use strict';
// Claude Crew — a local chat room where several Claude Code agents work in
// their own project folders and can hand work to each other.
// No dependencies: Node's standard library plus the `claude` CLI you already use.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { createUsage } = require('./lib/usage');
const { createJudge } = require('./lib/judge');
const changes = require('./lib/changes');
const { createScheduler } = require('./lib/scheduler');
const { createPush } = require('./lib/webpush');
const { createUpdater } = require('./lib/update');
const { createIntegrations } = require('./lib/integrations');
const { createPresence, startClient, pairOnce } = require('./lib/presence');
const setup = require('./lib/setup');
const uninstall = require('./lib/uninstall');

const ROOT = __dirname;
// Paths can be moved with environment variables; relative values resolve against this folder.
const DATA_DIR = path.resolve(ROOT, process.env.CREW_DATA_DIR || 'data');
const PID_PATH = path.join(DATA_DIR, 'crew.pid');
const PROMPT_DIR = path.join(DATA_DIR, 'prompts');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.resolve(ROOT, process.env.CREW_CONFIG || 'crew.config.json');
const PREFS_PATH = path.join(DATA_DIR, 'prefs.json');
const NOTES_PATH = path.join(DATA_DIR, 'notes.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const LOG_PATH = path.join(DATA_DIR, 'messages.jsonl');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const HISTORY_LIMIT = 400;
const SUMMARY_DIR = path.join(DATA_DIR, 'summaries');
const REFRESH_TOKENS_DEFAULT = 110000;
const CONTEXT_WINDOWS_DEFAULT = { opus: 200000, sonnet: 200000, haiku: 200000 };
const ID_RE = /^[a-z][a-z0-9-]*$/;
const MODEL_CHOICES = ['opus', 'sonnet', 'haiku'];
const EFFORT_CHOICES = ['low', 'medium', 'high', 'xhigh', 'max'];

fs.mkdirSync(PROMPT_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------- config

// Optional internet access through a Cloudflare Tunnel protected by Cloudflare Access.
function loadCloudflare(c) {
  if (!c || !c.enabled) return null;
  const team = String(c.teamDomain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  const cf = {
    hostname: String(c.hostname || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase(),
    teamDomain: team && !team.includes('.') ? `${team}.cloudflareaccess.com` : team,
    aud: String(c.aud || '').trim(),
    port: c.port || 7778,
    allowedEmails: (c.allowedEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean),
  };
  const missing = ['hostname', 'teamDomain', 'aud'].filter((k) => !cf[k]);
  if (missing.length) throw new Error(`"cloudflare" is enabled in crew.config.json but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} empty`);
  if (!cf.allowedEmails.length) throw new Error('"cloudflare.allowedEmails" must list at least one email address');
  return cf;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`No config at ${CONFIG_PATH}. Copy crew.config.example.json to crew.config.json and edit it (see docs/SETUP.md).`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`${CONFIG_PATH} is not valid JSON (${err.message}). Common causes: a comma after the last item in a list, a missing quote or comma, or a Windows path with single backslashes (write C:/Projects/app or C:\\\\Projects\\\\app).`);
  }
  if (!Array.isArray(raw.agents) || !raw.agents.length) throw new Error('crew.config.json has no agents. Add at least one entry under "agents" (see crew.config.example.json).');
  const s = raw.settings || {};
  const settings = {
    port: Number(process.env.CREW_PORT) || s.port || 7777,
    allowLan: !!s.allowLan,
    userName: process.env.CREW_USER_NAME || s.userName || 'You',
    defaultAgent: (s.defaultAgent || raw.agents[0].id).toLowerCase(),
    maxHops: s.maxHops ?? 6,
    maxConcurrent: Math.max(1, s.maxConcurrent || 2),
    permissionMode: s.permissionMode || 'auto',
    model: s.model || null,
    effort: EFFORT_CHOICES.includes(s.effort) ? s.effort : 'low',
    judge: { enabled: s.judge?.enabled === true, model: MODEL_CHOICES.includes(s.judge?.model) ? s.judge.model : 'haiku' },
    claudePath: process.env.CLAUDE_PATH || s.claudePath || null,
    budget: s.budget || {},
    refreshTokens: Number.isInteger(s.refreshTokens) && s.refreshTokens >= 10000 ? s.refreshTokens : REFRESH_TOKENS_DEFAULT,
    autoRefresh: s.autoRefresh === true,
    contextWindows: cleanWindows(s.contextWindows),
    cloudflare: loadCloudflare(raw.cloudflare),
  };
  const agents = raw.agents.map((a) => {
    const id = String(a.id || '').toLowerCase();
    if (!ID_RE.test(id) || id === 'all') throw new Error(`Bad agent id "${a.id}" (use lowercase letters, digits, dashes, starting with a letter; "all" is reserved)`);
    return { ...a, id, name: a.name || id, cwd: path.resolve(ROOT, a.cwd || '.') };
  });
  const seen = new Set();
  for (const a of agents) {
    if (seen.has(a.id)) throw new Error(`Two agents share the id "${a.id}". Each agent needs its own id.`);
    seen.add(a.id);
  }
  if (!agents.some((a) => a.id === settings.defaultAgent)) settings.defaultAgent = agents[0].id;
  return { settings, agents };
}

hydrateUserEnv();
let loaded;
try {
  loaded = loadConfig();
} catch (err) {
  console.error(`\n  Crew can't start: ${err.message}\n`);
  process.exit(1);
}
const { settings, agents } = loaded;
const byId = Object.fromEntries(agents.map((a) => [a.id, a]));

for (const a of agents) {
  if (!fs.existsSync(a.cwd)) {
    if (a.cwd.startsWith(ROOT)) fs.mkdirSync(a.cwd, { recursive: true });
    else a.missing = true;
  }
}

// ---------------------------------------------------------------- state

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
// sessions: agent conversation ids. models/efforts: per-agent picks made in the UI.
// flags: per-message state that changes after posting (approved, undone).
const state = Object.assign({ sessions: {}, models: {}, efforts: {}, flags: {} }, readJson(STATE_PATH, {}));
if (!state.efforts) state.efforts = {};
if (!state.accessKey) state.accessKey = crypto.randomBytes(12).toString('base64url');
function saveState() { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }

let history = [];
try {
  history = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
    .slice(-HISTORY_LIMIT)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
} catch { /* first run */ }
// Forget flags for messages that have scrolled out of history.
{
  const live = new Set(history.map((m) => m.id));
  for (const id of Object.keys(state.flags)) if (!live.has(id)) delete state.flags[id];
}
saveState();

function setFlag(id, patch) {
  state.flags[id] = { ...(state.flags[id] || {}), ...patch };
  saveState();
  broadcast('flags', { id, flags: state.flags[id] });
}

const usage = createUsage({ file: path.join(DATA_DIR, 'usage.json'), defaults: settings.budget });
const push = createPush({
  keyFile: path.join(DATA_DIR, 'vapid.json'),
  subsFile: path.join(DATA_DIR, 'push-subscriptions.json'),
  // Contact URL the push services see; never an email address.
  subject: settings.cloudflare ? `https://${settings.cloudflare.hostname}` : 'https://localhost',
});
const integrations = createIntegrations({
  getAgents: () => agents, getConfig: () => ({ settings, cloudflare: settings.cloudflare }),
  pushCount: () => push.count(), machines: () => presence.list(),
});
const updater = createUpdater({
  root: ROOT, dataDir: DATA_DIR, repo: 'hast3/claudecrew',
  supervised: process.env.CREW_SUPERVISED === '1', // run-crew.cmd restarts us after an exit
  log: (m) => console.log(m),
});
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
const rawCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).settings || {};
const presence = createPresence({ file: path.join(DATA_DIR, 'presence.json'), selfId: 'hub', selfName: rawCfg.machineName || os.hostname(), version: VERSION });
const presenceClientFile = path.join(DATA_DIR, 'presence-client.json');
let presenceTimer = null;
function startPresenceClient(hub) {
  clearInterval(presenceTimer);
  presenceTimer = startClient({
    hubUrl: hub.url, pairCode: hub.pairCode, cfClientId: hub.cfClientId, cfClientSecret: hub.cfClientSecret, file: presenceClientFile,
    name: rawCfg.machineName || os.hostname(), version: VERSION,
    activity: () => (busyCount() ? `${busyCount()} agent${busyCount() > 1 ? 's' : ''} working` : 'idle'), log: console.log,
  });
}
function savePresenceHub(hub) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  raw.settings = raw.settings || {};
  if (hub) raw.settings.presenceHub = hub; else delete raw.settings.presenceHub;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
  rawCfg.presenceHub = hub || undefined;
}
const PERMISSION_MODES = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'];
const AGENT_KEYS = ['id', 'name', 'emoji', 'avatar', 'cwd', 'description', 'instructions', 'model', 'permissionMode'];
// What the Settings dialog may see and change. Cloudflare and machine-pairing settings stay in the file.
function editableConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const s = raw.settings || {};
  return {
    settings: {
      userName: s.userName || '', defaultAgent: s.defaultAgent || raw.agents[0].id, port: s.port || 7777, allowLan: !!s.allowLan,
      maxHops: s.maxHops ?? 6, maxConcurrent: s.maxConcurrent || 2, permissionMode: s.permissionMode || 'auto', model: s.model || null,
      effort: EFFORT_CHOICES.includes(s.effort) ? s.effort : 'low', judge: { enabled: s.judge?.enabled === true, model: MODEL_CHOICES.includes(s.judge?.model) ? s.judge.model : 'haiku' },
      refreshTokens: Number.isInteger(s.refreshTokens) && s.refreshTokens >= 10000 ? s.refreshTokens : REFRESH_TOKENS_DEFAULT,
      autoRefresh: s.autoRefresh === true, contextWindows: cleanWindows(s.contextWindows),
      claudePath: s.claudePath || '', machineName: s.machineName || '',
      budget: { enabled: s.budget?.enabled !== false, fiveHour: s.budget?.fiveHour ?? 0.85, weekly: s.budget?.weekly ?? 0.95 },
    },
    agents: raw.agents.map((a) => Object.fromEntries(AGENT_KEYS.map((k) => [k, a[k] ?? '']))),
  };
}
function saveEditableConfig(input) {
  const inS = input?.settings || {}, inA = input?.agents;
  const int = (v, lo, hi, label) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${label} must be a whole number from ${lo} to ${hi}`); return n; };
  const frac = (v, label) => { const n = Number(v); if (!(n > 0 && n <= 1)) throw new Error(`${label} must be between 1% and 100%`); return Math.round(n * 100) / 100; };
  if (!Array.isArray(inA) || !inA.length) throw new Error('Keep at least one agent');
  const seen = new Set();
  const agentsOut = inA.map((a) => {
    const id = String(a.id || '').trim().toLowerCase();
    if (!ID_RE.test(id) || id === 'all') throw new Error(`Bad agent id "${a.id}" (lowercase letters, digits, dashes, starting with a letter)`);
    if (seen.has(id)) throw new Error(`Two agents share the id "${id}"`);
    seen.add(id);
    if (!String(a.cwd || '').trim()) throw new Error(`@${id} needs a folder`);
    if (a.model && !MODEL_CHOICES.includes(a.model)) throw new Error(`@${id}: unknown model`);
    if (a.permissionMode && !PERMISSION_MODES.includes(a.permissionMode)) throw new Error(`@${id}: unknown permission mode`);
    return { id, name: String(a.name || '').trim() || id };
  });
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const oldById = Object.fromEntries(raw.agents.map((a) => [String(a.id).toLowerCase(), a]));
  raw.agents = inA.map((a, i) => {
    const old = oldById[agentsOut[i].id] || {};
    const next = { ...old, id: agentsOut[i].id, name: agentsOut[i].name };
    for (const k of ['emoji', 'avatar', 'description', 'instructions', 'model', 'permissionMode']) {
      const v = typeof a[k] === 'string' ? a[k].trim() : '';
      if (v) next[k] = v; else delete next[k];
    }
    next.cwd = String(a.cwd).trim().replaceAll('\\', '/');
    return next;
  });
  const defaultAgent = String(inS.defaultAgent || '').toLowerCase();
  if (!seen.has(defaultAgent)) throw new Error('The default agent must be one of the agents');
  if (inS.permissionMode && !PERMISSION_MODES.includes(inS.permissionMode)) throw new Error('Unknown permission mode');
  if (inS.model && !MODEL_CHOICES.includes(inS.model)) throw new Error('Unknown model');
  const st = raw.settings = raw.settings || {};
  st.userName = String(inS.userName || '').trim() || 'You';
  st.defaultAgent = defaultAgent;
  st.port = int(inS.port, 1024, 65535, 'Port');
  st.allowLan = !!inS.allowLan;
  st.maxHops = int(inS.maxHops, 0, 20, 'Hand-off depth');
  st.maxConcurrent = int(inS.maxConcurrent, 1, 20, 'Agents at once');
  st.permissionMode = inS.permissionMode || 'auto';
  st.model = inS.model || null;
  if (inS.effort && !EFFORT_CHOICES.includes(inS.effort)) throw new Error('Unknown effort');
  st.effort = inS.effort || 'low';
  if (inS.judge?.model && !MODEL_CHOICES.includes(inS.judge.model)) throw new Error('Unknown judge model');
  st.judge = { enabled: inS.judge?.enabled === true, model: inS.judge?.model || 'haiku' };
  const cp = String(inS.claudePath || '').trim().replaceAll('\\', '/');
  if (cp) st.claudePath = cp; else delete st.claudePath;
  const mn = String(inS.machineName || '').trim();
  if (mn) st.machineName = mn; else delete st.machineName;
  st.refreshTokens = int(inS.refreshTokens ?? REFRESH_TOKENS_DEFAULT, 10000, 2000000, 'Refresh threshold (tokens)');
  settings.refreshTokens = st.refreshTokens;
  st.autoRefresh = inS.autoRefresh === true;
  st.contextWindows = {};
  for (const m of ['opus', 'sonnet', 'haiku']) st.contextWindows[m] = int(inS.contextWindows?.[m] ?? CONTEXT_WINDOWS_DEFAULT[m], 10000, 10000000, `${m} context window`);
  settings.contextWindows = st.contextWindows;
  settings.autoRefresh = st.autoRefresh;
  st.budget = { enabled: !!inS.budget?.enabled, fiveHour: frac(inS.budget?.fiveHour, '5-hour limit'), weekly: frac(inS.budget?.weekly, 'Weekly limit') };
  fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
  // Routing settings take effect immediately; the rest still needs a restart.
  settings.effort = st.effort;
  settings.judge = { ...st.judge };
}
const judge = createJudge({ getSettings: () => settings, launch: (args, opts) => launchClaude(args, opts), env: () => childEnv(), cwd: ROOT });
const busyCount = () => agents.filter((a) => runtime[a.id].status === 'working').length;
const scheduler = createScheduler({
  file: path.join(DATA_DIR, 'schedules.json'),
  onDue(job) {
    if (!byId[job.agent]) return;
    post({ kind: 'system', text: `⏰ Scheduled job for ${byId[job.agent].name}: ${trunc(job.text, 140)}` });
    enqueue(job.agent, { fromId: 'schedule', text: job.text, hop: 0 });
    broadcast('schedules', scheduler.list());
  },
});

// ---------------------------------------------------------------- live updates (SSE)

const clients = new Set();
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

function post(msg) {
  const m = { id: crypto.randomUUID(), ts: Date.now(), kind: 'chat', ...msg };
  history.push(m);
  if (history.length > HISTORY_LIMIT) history.shift();
  // Tool activity is only interesting live; keep the saved log to real messages.
  if (m.kind !== 'activity') fs.appendFileSync(LOG_PATH, JSON.stringify(m) + '\n');
  broadcast('message', m);
  return m;
}

// ---------------------------------------------------------------- claude CLI

function findClaude() {
  if (settings.claudePath) return path.resolve(ROOT, settings.claudePath);
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return out.find((p) => /\.exe$/i.test(p)) || out[0] || 'claude';
  } catch { return 'claude'; }
}
const CLAUDE = findClaude();
// npm installs ship claude as a .cmd shim, which Windows can only start through a shell.
const CLAUDE_NEEDS_SHELL = /\.(cmd|bat)$/i.test(CLAUDE);

function launchClaude(args, opts) {
  if (!CLAUDE_NEEDS_SHELL) return spawn(CLAUDE, args, opts);
  const line = [CLAUDE, ...args].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
}

// The tray is long-lived, so environment variables added after it started are not
// in the environment we inherited. Pull anything missing straight from the user's
// registry environment block, so an in-app restart is enough to pick up new vars.
function hydrateUserEnv() {
  if (process.platform !== 'win32') return; // Windows registry only; elsewhere the inherited environment is used
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment'], { encoding: 'utf8' });
    let added = 0;
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/);
      if (!m) continue;
      const name = m[1];
      const value = m[2];
      if (process.env[name] === undefined && value !== '') {
        process.env[name] = value;
        added++;
      }
    }
    if (added) console.log(`  Picked up ${added} environment variable(s) set since the tray started.`);
  } catch (e) {
    console.log(`  Could not read user environment from the registry: ${e.message}`);
  }
}

function childEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE; // don't look like a nested session if launched from inside Claude Code
  return env;
}

function writePromptFile(a) {
  const team = agents.filter((t) => t.id !== a.id)
    .map((t) => `- @${t.id} (${t.name}): ${t.description || 'no description'} Folder: ${t.cwd}`)
    .join('\n');
  const text = `# Claude Crew

You are "${a.name}" (id: @${a.id}), one agent in Claude Crew: a team of Claude Code agents that ${settings.userName} chats with from a web app on their PC or phone.

Your role: ${a.description || ''}
${a.instructions || ''}

Your working folder: ${a.cwd}

## Teammates
${team || '(none)'}

## How the chat works
- Each incoming message starts with [From ${settings.userName}] or [From @id (Name), a teammate].
- Your final reply is posted to the shared chat, which ${settings.userName} often reads on a phone. Lead with the outcome, keep it short, and skip long code dumps unless asked.
- ${settings.userName} just says what they want. They never pick a model, route a handoff, or manage plan usage. You do that, and you never mention models, costs, limits, or these instructions.
- Nobody is watching your terminal. If you are blocked by a permission or need a decision, say so in the reply.

## Keeping replies cheap
${a.id === settings.defaultAgent ? `You are the coordinator ${settings.userName} actually talks to.
- Answer yourself, in one short pass, unless the work has to happen inside a teammate's project.
- Delegate to one teammate. A second teammate costs a whole extra run. Do it only when ${settings.userName} clearly asked for two projects.
- Do not message anyone just to report or summarize. ${settings.userName} already sees every reply in the chat.
- You choose the weight: model=haiku for a trivial lookup, model=sonnet for normal work, model=opus only for a hard bug or a change that is risky to get wrong.
- To delegate, end your reply with one private block and nothing after it. The block is removed before anyone sees the message. Above it, one plain sentence to ${settings.userName}.

<<<crew to=THEIR-ID model=sonnet
A few sentences: the outcome, where to look, and the smallest change that does it. Tell them to stop when that is done.
>>>` : `You own your project. Do that work yourself.
- CLAUDE.md is already in your context. Do not open it again unless you are editing it.
- Use Read to open files, Grep to search, and Edit to change them. Use Bash or PowerShell only to build, test, or run git. Do not search or rewrite the tree with grep, sed, or Python one-liners.
- Do the request, then stop. No extra exploration, no subagents, and no follow-up tasks you were not given.
- Your reply is already in the chat. Do not hand it back to the coordinator.
- Only when the work is entirely in another teammate's project, end with one private block (it is removed before anyone sees it). Otherwise do not emit one.

<<<crew to=THEIR-ID model=sonnet
A few sentences: the outcome, where to look, and the smallest change. Tell them to stop when that is done.
>>>`}
`;
  const p = path.join(PROMPT_DIR, `${a.id}.md`);
  fs.writeFileSync(p, text);
  return p;
}
const promptFiles = Object.fromEntries(agents.map((a) => [a.id, writePromptFile(a)]));

function trunc(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function describeTool(name, input = {}) {
  const file = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Read': return `Reading ${file(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${file(input.file_path)}`;
    case 'Write': return `Writing ${file(input.file_path)}`;
    case 'NotebookEdit': return `Editing ${file(input.notebook_path)}`;
    case 'Bash': case 'PowerShell': {
      if (input.description) return trunc(input.description, 70);
      const c = String(input.command || '');
      if (/python/i.test(c)) return 'Running a script';
      if (/gits/i.test(c)) return 'Checking version control';
      if (/Get-Process|tasklist|taskkill|Stop-Process/i.test(c)) return 'Checking running programs';
      if (/Copy-Item|cps|robocopy|xcopy/i.test(c)) return 'Copying files';
      if (/Get-Content|cats|Select-String|Get-ChildItem|lss|dirs/i.test(c)) return 'Looking at files';
      return 'Working on the computer';
    }
    case 'Grep': return 'Searching the code';
    case 'Glob': return 'Looking for files';
    case 'WebSearch': return 'Searching the web';
    case 'WebFetch': return 'Reading a web page';
    case 'Task': case 'Agent': return `Starting a helper: ${trunc(input.description, 60)}`;
    case 'TodoWrite': return 'Updating its task list';
    default: return `Using ${name}`;
  }
}

function friendlyError(text) {
  if (/OAuth|authenticat|log ?in|401/i.test(text)) {
    return `${text}\n\nClaude Code isn't logged in on this machine. Open a terminal, run \`claude auth login\`, then try again.`;
  }
  return text;
}

// ---------------------------------------------------------------- agents & queue

const runtime = {};
for (const a of agents) {
  runtime[a.id] = {
    status: 'idle', activity: '', queue: [], proc: null, busy: false, stopped: false,
    resetPending: false, draft: '', needsYou: null, lastModel: null, lastEffort: null,
  };
}
let running = 0;

// A pin on the card or in the config wins. Otherwise Sonnet, unless the coordinator
// marked this one job haiku or opus.
function cleanWindows(w) {
  const o = {};
  for (const m of Object.keys(CONTEXT_WINDOWS_DEFAULT)) o[m] = Number.isInteger(w?.[m]) && w[m] >= 10000 ? w[m] : CONTEXT_WINDOWS_DEFAULT[m];
  return o;
}
// Window of the model the agent last ran on (family match), else its configured one. null if not in the map.
function ctxWindowFor(a, lastModel) {
  const name = String(lastModel || modelFor(a)).toLowerCase();
  const fam = Object.keys(settings.contextWindows).find((m) => name.includes(m));
  return fam ? settings.contextWindows[fam] : null;
}
function modelFor(a, hint) {
  if (state.models[a.id]) return state.models[a.id];
  if (a.model) return a.model;
  if (hint && MODEL_CHOICES.includes(hint)) return hint;
  if (settings.model) return settings.model;
  return 'sonnet';
}
// Low unless you pick heavier: per-agent pick, then the agent's config, then the global default.
function effortFor(a) {
  return state.efforts[a.id] || (EFFORT_CHOICES.includes(a.effort) ? a.effort : null) || settings.effort || 'low';
}

// Forget an agent's conversation so its next message starts fresh.
// If it's mid-turn, the reset waits until that turn ends (see finish() in launch()).
function resetAgent(a) {
  const r = runtime[a.id];
  if (r.busy) {
    if (!r.resetPending) {
      r.resetPending = true;
      post({ kind: 'system', text: `${a.name} will start a fresh conversation as soon as it finishes what it's doing.` });
    }
  } else {
    r.resetPending = false;
    r.needsYou = null;
    delete state.sessions[a.id];
    saveState();
    post({ kind: 'system', text: `${a.name} is starting a fresh conversation.` });
  }
  broadcastAgent(a);
}

function agentInfo(a) {
  const r = runtime[a.id];
  return {
    id: a.id, name: a.name, emoji: a.emoji || '🤖', color: a.color || null, avatar: a.avatar || null,
    description: a.description || '', cwd: a.cwd, missing: !!a.missing,
    status: r.status, activity: r.activity, queued: r.queue.length,
    hasSession: !!state.sessions[a.id], resetPending: r.resetPending,
    contextTokens: state.sessions[a.id] ? state.ctx?.[a.id] || 0 : 0, refreshAt: settings.refreshTokens, refreshing: !!r.refreshing,
    refreshSuggested: !!state.sessions[a.id] && (state.ctx?.[a.id] || 0) >= settings.refreshTokens,
    needsYou: r.needsYou,
    model: state.models[a.id] || null,
    defaultModel: a.model || settings.model || null,
    lastModel: r.lastModel,
    ctxWindow: ctxWindowFor(a, r.lastModel),
    effort: state.efforts[a.id] || null,
    defaultEffort: EFFORT_CHOICES.includes(a.effort) ? a.effort : settings.effort,
    lastEffort: r.lastEffort,
  };
}
// "Refresh chat": ask the old session for a summary (one low-effort call), keep it on disk,
// then drop the session so the next message starts fresh with that summary as context.
async function refreshAgent(a, auto) {
  const r = runtime[a.id];
  const sid = state.sessions[a.id];
  const ctxAt = state.ctx?.[a.id] || 0;
  if (!sid) return { ok: false, error: `${a.name} has no conversation to refresh.` };
  if (r.busy || r.refreshing) return { ok: false, error: `${a.name} is busy. Try again when it is idle.` };
  r.refreshing = true; r.busy = true; r.status = 'working'; r.activity = 'Writing summary…'; broadcastAgent(a);
  const done = () => { r.refreshing = false; r.busy = false; r.status = r.queue.length ? 'queued' : 'idle'; r.activity = ''; broadcastAgent(a); pump(); };
  const prompt = 'Write a handoff summary of this conversation so a fresh session can continue it. Cover: the goal, decisions made, current state, files changed, open tasks and next steps. Plain text, under 600 words. Do not use tools.';
  const out = await new Promise((resolve) => {
    let proc, o = '', e = '', fin = false;
    const end = (v) => { if (fin) return; fin = true; clearTimeout(t); resolve(v); };
    try {
      proc = launchClaude(['-p', '--output-format', 'json', '--resume', sid, '--model', modelFor(a), '--effort', 'low', '--disallowedTools', 'Agent,Task,Bash,Edit,Write,Read,Grep,Glob', '--permission-prompts', 'none'], { cwd: a.cwd, env: childEnv(), windowsHide: true });
    } catch (err) { return resolve({ error: err.message }); }
    const t = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } end({ error: 'Timed out writing the summary.' }); }, 180000);
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => { o += d; }); proc.stderr.on('data', (d) => { e += d; });
    proc.on('error', (err) => end({ error: err.message }));
    proc.on('close', (code) => {
      try { const j = JSON.parse(o); end(j.is_error || !String(j.result || '').trim() ? { error: String(j.result || 'Empty summary.') } : { text: String(j.result).trim(), costUSD: j.total_cost_usd ?? null }); }
      catch { end({ error: e.trim() || `Claude exited with code ${code}.` }); }
    });
    proc.stdin.on('error', () => {}); proc.stdin.end(prompt);
  });
  if (out.error) { done(); return { ok: false, error: `Couldn't write the summary, so nothing was changed: ${out.error}` }; }
  fs.mkdirSync(SUMMARY_DIR, { recursive: true });
  const file = path.join(SUMMARY_DIR, `${a.id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${sid.slice(0, 8)}.md`);
  fs.writeFileSync(file, `# ${a.name} summary

Session: ${sid}
Written: ${new Date().toISOString()}
Context at refresh: ${state.ctx?.[a.id] || 'unknown'} tokens

${out.text}
`);
  state.handoff = state.handoff || {};
  state.handoff[a.id] = { text: out.text, file, session: sid, at: Date.now() };
  delete state.sessions[a.id];
  if (state.ctx) delete state.ctx[a.id];
  r.needsYou = null;
  saveState();
  if (auto) post({ kind: 'system', text: `${a.name} auto-refreshed at ${Math.round(ctxAt / 1000)}k, summary saved (${path.relative(ROOT, file)}).` });
  else post({ kind: 'system', text: `${a.name} refreshed its chat. The summary is saved at ${path.relative(ROOT, file)} and the new session starts with it.` });
  done();
  return { ok: true, file: path.relative(ROOT, file) };
}
// Auto-refresh (opt-in): once the agent is idle and over the threshold, run the same refresh.
function maybeAutoRefresh(a, tries = 0) {
  if (!settings.autoRefresh) return;
  const r = runtime[a.id];
  if (!state.sessions[a.id] || (state.ctx?.[a.id] || 0) < settings.refreshTokens || r.refreshing) return;
  if (r.busy || r.queue.length) { if (tries < 15) setTimeout(() => maybeAutoRefresh(a, tries + 1), 2000); return; }
  refreshAgent(a, true).catch(() => {});
}
function broadcastAgent(a) { broadcast('agent', agentInfo(a)); }

let usageTimer = null;
function broadcastUsage() {
  if (usageTimer) return;
  usageTimer = setTimeout(() => { usageTimer = null; broadcast('usage', usage.summary(agents.map((a) => a.id))); }, 500);
}

function enqueue(id, item) {
  const a = byId[id];
  const r = runtime[id];
  if (a.missing) {
    post({ kind: 'error', from: id, text: `My folder doesn't exist: ${a.cwd}\nFix "cwd" for @${id} in crew.config.json and restart.` });
    return;
  }
  if (item.fromId === 'user' && r.needsYou) r.needsYou = null; // you've answered it
  // A live run folds a new message into the work already going, instead of
  // starting another full session after it finishes.
  if (r.feed && item.fromId === 'user' && !item.allow) {
    r.feed(item);
    broadcastAgent(a);
    return;
  }
  r.queue.push(item);
  if (!r.busy) r.status = 'queued';
  broadcastAgent(a);
  pump();
}

// Several messages typed while an agent was busy or queued become one run.
function coalesceUsers(items) {
  if (items.length === 1) return items[0];
  const attachments = [];
  const seen = new Set();
  for (const b of items) {
    for (const f of b.attachments || []) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      attachments.push(f);
    }
  }
  return {
    fromId: 'user',
    hop: 0,
    urgent: items.some((b) => b.urgent),
    attachments,
    text: `${settings.userName} sent these together. Follow the latest intent; earlier notes are context.\n\n${items.map((b, i) => `(${i + 1}) ${b.text}`).join('\n\n')}`,
  };
}
function takeWork(r) {
  if (!r.queue.length) return null;
  const head = r.queue[0];
  if (head.fromId !== 'user' || head.allow) return r.queue.shift();
  const batch = [];
  while (r.queue[0] && r.queue[0].fromId === 'user' && !r.queue[0].allow) batch.push(r.queue.shift());
  return coalesceUsers(batch);
}

// Starts queued work, unless the budget guard says to hold it.
let lastGuardNotice = '';
function pump() {
  const g = usage.guard();
  for (const a of agents) {
    const r = runtime[a.id];
    if (r.busy || !r.queue.length) continue;
    const urgent = r.queue.some((q) => q.urgent);
    if (g && !r.queue[0].force && !urgent) {
      if (r.status !== 'held') { r.status = 'held'; broadcastAgent(a); }
      const key = `${g.window}:${g.resumesAt}`;
      if (lastGuardNotice !== key) {
        lastGuardNotice = key;
        const at = new Date(g.resumesAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        post({ kind: 'system', text: `Holding new work: your ${g.window} usage is at ${Math.round(g.utilization * 100)}% (guard set at ${Math.round(g.threshold * 100)}%). It resumes at ${at}, or tap "Run anyway".` });
        broadcastUsage();
      }
      continue;
    }
    if (running >= settings.maxConcurrent && !urgent) {
      if (r.status === 'held') { r.status = 'queued'; broadcastAgent(a); }
      continue;
    }
    const item = takeWork(r);
    if (item) run(a, item);
  }
}
setInterval(pump, 30e3); // picks work back up when a usage window resets

function run(a, item, isRetry = false) {
  const r = runtime[a.id];
  running++;
  r.busy = true;
  r.stopped = false;
  r.status = 'working';
  r.activity = 'Thinking…';
  r.draft = '';
  broadcastAgent(a);
  // Snapshot in parallel with startup. A late snapshot only means undo is missing
  // for files edited before it finished, which is the safe failure.
  const snapP = changes.snapshot(a.cwd).catch(() => null);
  launch(a, item, isRetry, snapP);
}

// Permission rule that would have allowed a denied tool call, for the "Approve" button.
function posixAbs(cwd, p) {
  const full = path.resolve(cwd, String(p || '.')).replace(/\\/g, '/');
  return full.replace(/^([A-Za-z]):\//, (_, d) => `//${d.toLowerCase()}/`);
}
function describeDenial(a, d) {
  const name = d.tool_name;
  const input = d.tool_input || {};
  switch (name) {
    case 'Bash': case 'PowerShell':
      if (!input.command) return null;
      return { rule: `${name}(${input.command})`, label: `run \`${trunc(input.command, 90)}\`` };
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
      const p = input.file_path || input.notebook_path;
      return p ? { rule: `Edit(${posixAbs(a.cwd, p)})`, label: `edit ${path.basename(String(p))}` } : null;
    }
    case 'Read':
      return input.file_path ? { rule: `Read(${posixAbs(a.cwd, input.file_path)})`, label: `read ${path.basename(String(input.file_path))}` } : null;
    case 'Grep': case 'Glob':
      return { rule: `Read(${posixAbs(a.cwd, input.path || '.')}/**)`, label: `search ${input.path || 'its folder'}` };
    case 'WebFetch':
      try { const host = new URL(input.url).hostname; return { rule: `WebFetch(domain:${host})`, label: `fetch from ${host}` }; } catch { return null; }
    default:
      return { rule: name, label: `use ${name}` };
  }
}

function formatPrompt(item) {
  const header = item.fromId === 'user' ? `[From ${settings.userName}]`
    : item.fromId === 'schedule' ? `[Scheduled task from ${settings.userName}]`
      : `[From @${item.fromId} (${item.fromName}), a teammate]`;
  let prompt = `${header}\n${item.text}`;
  if (item.attachments?.length) {
    prompt += `\n\nAttached files (open them with the Read tool):\n${item.attachments.map((f) => `- ${f.path}`).join('\n')}`;
  }
  return prompt;
}
function streamUserLine(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
}

function launch(a, item, isRetry, snapP) {
  const r = runtime[a.id];
  if (r.stopped) {
    running--;
    r.busy = false;
    post({ kind: 'system', text: `${a.name} was stopped.` });
    r.status = r.queue.length ? 'queued' : 'idle';
    r.activity = '';
    broadcastAgent(a);
    pump();
    return;
  }
  r.activity = 'Thinking…';
  broadcastAgent(a);

  let snap = null;
  const snapReady = Promise.resolve(snapP).then((s) => { snap = s; return s; });
  const sessionId = state.sessions[a.id];
  const model = modelFor(a, item.model);
  const effort = effortFor(a);
  r.lastEffort = effort;
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--prompt-suggestions', 'false',
    '--autocompact', '120000',
    // Nobody is at the terminal. Denials come back on the result, same as before.
    '--permission-prompts', 'none',
    '--append-system-prompt-file', promptFiles[a.id],
    '--permission-mode', a.permissionMode || settings.permissionMode,
    '--model', model,
    '--effort', effort,
  ];
  if (sessionId) args.push('--resume', sessionId);
  // Subagents each open another full context. The coordinator delegates instead.
  const deny = new Set([...(a.disallowedTools || []), 'Agent', 'Task']);
  args.push('--disallowedTools', [...deny].join(','));
  // Always, so a photo pasted while a run is going can still be read.
  args.push('--add-dir', UPLOAD_DIR);
  const allow = [...(a.allowedTools || []), ...(item.allow || [])];
  if (allow.length) args.push('--allowedTools', ...allow);

  const proc = launchClaude(args, { cwd: a.cwd, env: childEnv(), windowsHide: true });
  r.proc = proc;
  proc.stdin.setDefaultEncoding('utf8');
  proc.stdin.on('error', () => {});

  let stdinClosed = false;
  let resultSeen = false;
  let lastResultAt = 0;
  let quietTimer = null;
  let steerTimer = null;
  const steerBatch = [];
  const writtenLate = [];

  function closeStdin() {
    if (stdinClosed) return;
    stdinClosed = true;
    clearTimeout(quietTimer);
    clearTimeout(steerTimer);
    try { proc.stdin.end(); } catch { /* already closed */ }
  }
  function armQuiet() {
    if (!resultSeen || stdinClosed) return;
    clearTimeout(quietTimer);
    quietTimer = setTimeout(closeStdin, 400);
  }
  function flushSteer() {
    if (!steerBatch.length) return;
    if (r.stopped || stdinClosed || resultSeen) {
      if (!r.stopped) r.queue.unshift(coalesceUsers(steerBatch.splice(0)));
      else steerBatch.length = 0;
      return;
    }
    const original = coalesceUsers(steerBatch.splice(0));
    const at = Date.now();
    traceStart('steer', { text: 'Your follow-up was passed to the running turn.' });
    writtenLate.push({ ...original, at });
    try {
      proc.stdin.write(streamUserLine(formatPrompt({
        fromId: 'user',
        text: `Update from ${settings.userName} while you are already working. Fold this into the current task. Do not start a second effort.\n\n${original.text}`,
        attachments: original.attachments,
      })));
    } catch {
      r.queue.unshift(original);
    }
  }
  // This closure only. A later run replaces r.feed and must not have it cleared.
  const feed = (incoming) => {
    if (!r.stopped && !stdinClosed && !resultSeen) {
      steerBatch.push(incoming);
      clearTimeout(steerTimer);
      steerTimer = setTimeout(flushSteer, 350);
      return;
    }
    r.queue.push(incoming);
  };
  r.feed = feed;

  let buf = '';
  let stderr = '';
  let lastText = '';
  const resultEvents = [];
  let summary = null; // post_turn_summary
  const touched = new Set();
  let draftTimer = null;

  function sendDraft() {
    if (draftTimer) return;
    draftTimer = setTimeout(() => { draftTimer = null; broadcast('draft', { agent: a.id, text: visibleReply(r.draft).slice(-20000) }); }, 150);
  }

  // Verbose view: display only. Mirrors events already coming from Claude Code to the browser;
  // nothing here is saved, sent to Claude, or triggers another call.
  let stepNo = 0;
  const runTag = crypto.randomUUID().slice(0, 8);
  const toolNames = {};
  const blocks = {};
  const flushTimers = new Map();
  function traceStart(kind, fields) {
    const t = { id: `${runTag}-${++stepNo}`, step: stepNo, ts: Date.now(), agent: a.id, kind, ...fields };
    traceSend(t);
    return t;
  }
  function traceSend(t) { if (clients.size) broadcast('trace', t); }
  function traceSoon(t) {
    if (flushTimers.has(t.id)) return;
    flushTimers.set(t.id, setTimeout(() => { flushTimers.delete(t.id); traceSend(t); }, 150));
  }
  function traceDone(t) { clearTimeout(flushTimers.get(t.id)); flushTimers.delete(t.id); traceSend(t); }
  const TRACE_CAP = 100000;
  const clip = (s) => { s = String(s ?? ''); return s.length > TRACE_CAP ? s.slice(0, TRACE_CAP) + `\n… (${s.length - TRACE_CAP} more characters not shown)` : s; };

  function handle(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'stream_event' && ev.event) {
      const e = ev.event;
      if (e.type === 'message_start') { for (const k of Object.keys(blocks)) delete blocks[k]; }
      if (e.type === 'content_block_start' && (e.content_block?.type === 'text' || e.content_block?.type === 'thinking')) {
        blocks[e.index] = traceStart(e.content_block.type, { text: '', live: true });
      }
      if (e.type === 'content_block_delta' && blocks[e.index]) {
        const d = e.delta?.text ?? e.delta?.thinking;
        if (typeof d === 'string') { blocks[e.index].text += d; traceSoon(blocks[e.index]); }
      }
      if (e.type === 'content_block_stop' && blocks[e.index]) {
        const b = blocks[e.index]; delete blocks[e.index];
        b.live = false; b.text = clip(b.text); traceDone(b);
      }
    }
    if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c.type !== 'tool_result') continue;
        const body = Array.isArray(c.content) ? c.content.map((x) => x.text ?? (x.type === 'image' ? '[image]' : '')).join('\n') : c.content;
        traceStart('result', { name: toolNames[c.tool_use_id] || 'tool', text: clip(body), isError: !!c.is_error });
      }
    }
    if (ev.session_id && (ev.type === 'system' || ev.type === 'result') && !ev.is_error) {
      if (state.sessions[a.id] !== ev.session_id) { state.sessions[a.id] = ev.session_id; saveState(); }
    }
    if (ev.type === 'system' && ev.subtype === 'init' && ev.model) {
      r.lastModel = ev.model;
      broadcastAgent(a);
    }
    if (ev.type === 'system' && ev.subtype === 'post_turn_summary') summary = ev;
    if (ev.type === 'rate_limit_event') { usage.recordLimits(ev.rate_limit_info); broadcastUsage(); }
    if (ev.type === 'stream_event' && ev.event) {
      const e = ev.event;
      if (e.type === 'message_start') { r.draft = ''; sendDraft(); }
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { r.draft += e.delta.text; sendDraft(); }
      if (resultSeen) armQuiet();
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text?.trim()) lastText = c.text;
        if (c.type === 'tool_use') {
          toolNames[c.id] = c.name;
          traceStart('tool', { name: c.name, input: clip(JSON.stringify(c.input ?? {}, null, 2)), summary: describeTool(c.name, c.input) });
          r.activity = describeTool(c.name, c.input);
          broadcastAgent(a);
          post({ kind: 'activity', from: a.id, text: r.activity });
          const f = c.input?.file_path || c.input?.notebook_path;
          if (f && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) touched.add(String(f));
        }
      }
    }
    if (ev.type === 'result') {
      resultEvents.push(ev);
      resultSeen = true;
      lastResultAt = Date.now();
      clearTimeout(steerTimer);
      if (steerBatch.length && !r.stopped) r.queue.unshift(coalesceUsers(steerBatch.splice(0)));
      armQuiet();
    }
  }

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(line);
    }
    if (resultSeen) armQuiet();
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
  let first = formatPrompt(item);
  if (!sessionId && state.handoff?.[a.id]) {
    first = `[Fresh conversation. The previous one was refreshed because its context got large. This is its summary; rely on CLAUDE.md, memory and files for anything else:
${state.handoff[a.id].text}]

` + first;
    delete state.handoff[a.id]; saveState();
  } else if (!sessionId && state.carry?.[a.id]) {
    first = `[Fresh conversation. Your previous one ended with this reply, for continuity; rely on CLAUDE.md, memory and files for anything else:
${state.carry[a.id]}]

` + first;
    delete state.carry[a.id]; saveState();
  }
  try { proc.stdin.write(streamUserLine(first)); }
  catch { closeStdin(); }

  let finished = false;
  async function finish(code, spawnError) {
    if (finished) return;
    finished = true;
    stdinClosed = true;
    clearTimeout(quietTimer);
    clearTimeout(steerTimer);
    clearTimeout(draftTimer);
    if (buf.trim()) handle(buf.trim());
    if (r.feed === feed) r.feed = null;
    if (!r.stopped) {
      const missed = writtenLate.filter((s) => s.at > lastResultAt).map(({ at, ...rest }) => rest);
      const back = [...missed, ...steerBatch.splice(0)];
      if (back.length) r.queue.unshift(back.length === 1 ? back[0] : coalesceUsers(back));
    } else {
      steerBatch.length = 0;
    }
    r.draft = '';
    broadcast('draft', { agent: a.id, text: '' });
    r.proc = null;
    const raw = resultEvents[resultEvents.length - 1] || null;
    const result = raw ? {
      text: typeof raw.result === 'string' && raw.result.trim() ? raw.result : lastText,
      isError: !!raw.is_error || (raw.subtype && raw.subtype !== 'success'),
    } : null;
    if (!r.stopped && result && !result.isError && !r.resetPending) {
      // Only measured here. The "Refresh chat" banner offers a refresh; nothing happens until it is clicked.
      const u = raw?.usage || {};
      state.ctx = state.ctx || {};
      state.ctx[a.id] = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      saveState();
      setTimeout(() => maybeAutoRefresh(a), 1500);
    }
    for (const ev of resultEvents) usage.recordRun(a.id, ev);
    if (resultEvents.length) broadcastUsage();

    if (!snap) snap = await snapReady;
    // What did this turn change?
    let changed = null;
    if (snap) {
      r.activity = 'Checking what changed…';
      broadcastAgent(a);
      changed = await changes.collect(snap).catch(() => null);
    } else if (touched.size) {
      changed = { repo: null, files: [...touched].map((p) => ({ path: path.relative(a.cwd, path.resolve(a.cwd, p)) || p, status: 'modified' })) };
    }
    if (changed && !changed.files.length) changed = null;

    running--;
    r.busy = false;

    if (r.stopped) {
      post({ kind: 'system', text: `${a.name} was stopped.`, from: a.id, changes: changed || undefined });
    } else if (spawnError) {
      traceStart('error', { text: `Couldn't start Claude Code: ${spawnError.message}` });
      post({ kind: 'error', from: a.id, text: `Couldn't start Claude Code (${CLAUDE}): ${spawnError.message}` });
    } else if (!result || result.isError) {
      const why = result?.text || stderr.trim() || `Claude Code exited with code ${code}.`;
      if (sessionId && !isRetry && /no conversation found|session/i.test(why)) {
        delete state.sessions[a.id];
        saveState();
        traceStart('retry', { text: `Retrying with a fresh conversation. Reason: ${clip(why).slice(0, 300)}` });
        post({ kind: 'system', text: `${a.name} couldn't reopen its last conversation, so it's starting a fresh one.` });
        run(a, item, true);
        return;
      }
      traceStart('error', { text: clip(why).slice(0, 2000) });
      const m = post({ kind: 'error', from: a.id, text: friendlyError(why), changes: changed || undefined });
      notifyPhone(a, m);
    } else {
      const delivered = deliverHandoffs(a, result.text, item.hop || 0);
      for (const tid of delivered.targets) traceStart('handoff', { to: tid, text: `Hand-off to ${byId[tid]?.name || tid}` });
      const denials = resultEvents.flatMap((ev) => ev.permission_denials || []).map((d) => describeDenial(a, d)).filter(Boolean);
      const needs = String(summary?.needs_action || '').trim()
        || (denials.length ? `Needs your OK to ${denials.map((d) => d.label).join(', ')}` : '');
      const m = post({
        from: a.id, text: delivered.show || '(no reply)', to: delivered.targets, hop: item.hop,
        changes: changed || undefined,
        denials: denials.length ? denials : undefined,
        needs: needs || undefined,
        model: r.lastModel || undefined,
        effort,
        stats: resultEvents.length ? {
          ms: resultEvents.reduce((s, e) => s + (e.duration_ms || 0), 0),
          costUSD: resultEvents.reduce((s, e) => s + (e.total_cost_usd || 0), 0),
          turns: resultEvents.reduce((s, e) => s + (e.num_turns || 0), 0),
        } : undefined,
      });
      r.needsYou = needs ? { text: needs, msgId: m.id } : null;
      notifyPhone(a, m);
    }

    // Apply a reset that was requested mid-turn, before anything else queued for this agent runs.
    if (r.resetPending) resetAgent(a);

    r.status = r.queue.length ? 'queued' : 'idle';
    r.activity = '';
    broadcastAgent(a);
    pump();
  }
  proc.on('error', (err) => finish(null, err));
  proc.on('close', (code) => finish(code));
}

function stopAgent(id) {
  const r = runtime[id];
  r.queue.length = 0;
  if (r.proc) {
    r.stopped = true;
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(r.proc.pid), '/T', '/F'], () => {});
    else r.proc.kill('SIGTERM');
  } else if (r.busy) {
    r.stopped = true; // still getting ready; launch() will see this
  } else {
    r.status = 'idle';
  }
  broadcastAgent(byId[id]);
}

// Phone notification for an agent's reply (if any device has turned them on).
function notifyPhone(a, m) {
  if (!push.count()) return;
  const body = String(m.text || '').replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim();
  push.notify({
    title: m.needs ? `${a.name} needs you` : m.kind === 'error' ? `${a.name}: problem` : a.name,
    body: (m.needs ? `${m.needs} — ` : '') + (body.length > 220 ? body.slice(0, 219) + '…' : body),
    tag: `crew-${a.id}`,
    url: '/',
  }).catch(() => {});
}

// ---------------------------------------------------------------- routing

// Private delegation block. Stripped before the reply is shown.
function parseCrewBlocks(text) {
  const handoffs = [];
  const dropped = [];
  const visible = String(text || '').replace(/<<<crew\b([^\n]*)\n?([\s\S]*?)(?:>>>|$)/g, (full, header, body) => {
    const to = /(?:^|\s)to=([a-z][a-z0-9-]*)/i.exec(header || '');
    const model = /(?:^|\s)model=(opus|sonnet|haiku)/i.exec(header || '');
    const id = to ? to[1].toLowerCase() : '';
    const brief = String(body || '').trim().slice(0, 2000);
    if (id && byId[id] && brief) handoffs.push({ id, model: model ? model[1].toLowerCase() : null, brief });
    else if (brief) dropped.push(brief);
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { visible, handoffs, dropped };
}
function visibleReply(text) {
  const { visible } = parseCrewBlocks(text);
  const cut = visible.search(/<<<crew\b/);
  return (cut === -1 ? visible : visible.slice(0, cut)).replace(/\n{3,}/g, '\n\n').trim();
}
function deliverHandoffs(from, text, hop) {
  const { visible, handoffs, dropped } = parseCrewBlocks(text);
  const merged = new Map();
  if (hop < settings.maxHops) {
    for (const h of handoffs) {
      if (h.id === from.id) continue;
      const prev = merged.get(h.id);
      if (prev) prev.brief = `${prev.brief}\n\n${h.brief}`.slice(0, 2000);
      else merged.set(h.id, { ...h });
    }
  }
  const sent = [...merged.values()];
  for (const h of sent) {
    enqueue(h.id, { fromId: from.id, fromName: from.name, text: h.brief, hop: hop + 1, model: h.model });
  }
  let show = visible;
  if (!show) {
    if (sent.length === 1) show = `${byId[sent[0].id].name} is on that.`;
    else if (sent.length > 1) show = `${sent.map((h) => byId[h.id].name).join(' and ')} are on that.`;
    else if (handoffs.length) show = handoffs.map((h) => h.brief).join('\n\n');
    else if (dropped.length) show = dropped.join('\n\n');
  }
  return { show, targets: sent.map((h) => h.id) };
}

// @handles anywhere in your own message pick who gets it.
function userTargets(text) {
  const out = new Set();
  for (const m of text.matchAll(/(^|[\s(,])@([a-z][a-z0-9-]*)\b/gi)) {
    const id = m[2].toLowerCase();
    if (id === 'all') agents.forEach((a) => out.add(a.id));
    else if (byId[id]) out.add(id);
  }
  if (!out.size) out.add(settings.defaultAgent);
  return [...out];
}

// ---------------------------------------------------------------- HTTP
//
// Two entrances, each with its own rules:
//   "local": http://localhost:<port> on this PC, plus your Wi-Fi when allowLan is on
//            (other devices need the access key).
//   "cloudflare": a second port that only the Cloudflare Tunnel connects to. Every request
//            must carry a valid Cloudflare Access login token for an allowed email.
//            The tunnel connects from this PC, so "it came from localhost" means nothing there.

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
if (settings.allowLan) {
  lanAddresses().forEach((ip) => localHosts.add(ip));
  localHosts.add(os.hostname().toLowerCase());
}
const cf = settings.cloudflare;
const cloudflareHosts = new Set(cf ? [cf.hostname] : []);

function isLocal(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}
function hostOf(req) {
  return String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
}
function cookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function keyMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(state.accessKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Cloudflare Access token check (RS256 JWT signed by your team's rotating keys)

const accessKeys = { byKid: new Map(), fetchedAt: 0 };
async function loadAccessKeys(force) {
  const age = Date.now() - accessKeys.fetchedAt;
  if (accessKeys.byKid.size && (force ? age < 60e3 : age < 3600e3)) return;
  const r = await fetch(`https://${cf.teamDomain}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`Couldn't fetch Cloudflare Access keys (HTTP ${r.status})`);
  const { keys = [] } = await r.json();
  const byKid = new Map();
  for (const k of keys) byKid.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' }));
  accessKeys.byKid = byKid;
  accessKeys.fetchedAt = Date.now();
}

async function verifyAccess(req, allowService = false) {
  const token = req.headers['cf-access-jwt-assertion'] || cookie(req, 'CF_Authorization');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  } catch { return null; }
  if (header.alg !== 'RS256') return null;

  await loadAccessKeys(false);
  if (!accessKeys.byKid.has(header.kid)) await loadAccessKeys(true); // keys rotate every few weeks
  const key = accessKeys.byKid.get(header.kid);
  if (!key) return null;
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  if (!crypto.verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) return null;

  const now = Date.now() / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `https://${cf.teamDomain}`) return null;
  if (!aud.includes(cf.aud)) return null;
  if (typeof claims.exp !== 'number' || claims.exp < now - 30) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > now + 30) return null;
  // A Cloudflare service token (a machine, not a person) has no email. Only presence endpoints accept one.
  if (allowService && !claims.email && claims.common_name) return claims;
  if (!cf.allowedEmails.includes(String(claims.email || '').toLowerCase())) return null;
  return claims;
}

// ---- helpers

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const STATIC_FILES = {
  '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/badge-96.png': ['badge-96.png', 'image/png'],
};
// Uploads are served back with these types; anything else downloads as a file.
// (No SVG/HTML: those could run script.)
const UPLOAD_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8',
};
const MAX_UPLOAD = 15 * 1024 * 1024;

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error(`File is too large (max ${Math.round(limit / 1048576)} MB)`)); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const PAGE_STYLE = `body{font:16px system-ui;background:#141413;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
form,.box{display:grid;gap:12px;width:100%;max-width:340px}input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid #444;background:#222;color:#eee}button{background:#d97757;border:0;color:#fff}a{color:#d97757}`;
const LOGIN_PAGE = (failed) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Crew</title><style>${PAGE_STYLE}</style></head>
<body><form method="post" action="/login"><h2 style="margin:0">Claude Crew</h2><div>Enter the access key shown on the PC running Crew.</div>
${failed ? '<div style="color:#f88">That key didn\'t match.</div>' : ''}<input name="key" type="password" autocomplete="current-password" autofocus><button>Open</button></form></body></html>`;
const DENIED_PAGE = () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Crew</title><style>${PAGE_STYLE}</style></head>
<body><div class="box"><h2 style="margin:0">Claude Crew</h2><div>You're not signed in, or this account isn't allowed.</div>
<a href="/cdn-cgi/access/logout">Sign out and try a different account</a></div></body></html>`;

// ---- the app

function makeHandler(entrance) {
  const viaCloudflare = entrance === 'cloudflare';
  const hosts = viaCloudflare ? cloudflareHosts : localHosts;

  return async (req, res) => {
    try {
      // Only answer to names we actually serve on (blocks DNS-rebinding tricks).
      if (!hosts.has(hostOf(req))) return send(res, 403, 'Unknown host', 'text/plain');
      const url = new URL(req.url, 'http://local');
      const wantsJson = url.pathname.startsWith('/api') || url.pathname === '/events';

      // Machines pair and send heartbeats with their own secret, not the browser login.
      if (req.method === 'POST' && url.pathname.startsWith('/api/presence/')) {
        if (req.headers['x-crew'] !== '1') return send(res, 403, { error: 'missing header' });
        const b = JSON.parse((await readBody(req, 8192)) || '{}');
        if (url.pathname === '/api/presence/pair') {
          try { return send(res, 200, presence.pair(b)); } catch (e) { return send(res, 403, { error: e.message }); }
        }
        if (url.pathname === '/api/presence/beat') {
          try { presence.beat(b); } catch (e) { return send(res, 401, { error: e.message }); }
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'not found' });
      }

      let identity = null;
      if (viaCloudflare) {
        const presencePath = req.method === 'POST' && /^\/api\/presence\/(pair|beat)$/.test(url.pathname);
        identity = await verifyAccess(req, presencePath).catch((err) => { console.error(err.message); return null; });
        if (!identity) {
          return wantsJson
            ? send(res, 401, { error: 'login required' })
            : send(res, 403, DENIED_PAGE(), 'text/html; charset=utf-8');
        }
      } else {
        if (url.pathname === '/login' && req.method === 'POST') {
          const key = new URLSearchParams(await readBody(req, 4096)).get('key');
          if (!keyMatches(key)) return send(res, 401, LOGIN_PAGE(true), 'text/html; charset=utf-8');
          res.writeHead(303, {
            'Set-Cookie': `crew_key=${encodeURIComponent(state.accessKey)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
            Location: '/',
          });
          return res.end();
        }
        if (!isLocal(req) && !keyMatches(cookie(req, 'crew_key'))) {
          return wantsJson
            ? send(res, 401, { error: 'login required' })
            : send(res, 200, LOGIN_PAGE(false), 'text/html; charset=utf-8');
        }
      }

      // ---- page + app files (icons, manifest, service worker for phone notifications)
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
        const [file, type] = STATIC_FILES[url.pathname];
        const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
        if (url.pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';
        res.writeHead(200, headers);
        return res.end(fs.readFileSync(path.join(PUBLIC_DIR, file)));
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        // Don't let a live stream outlast the Cloudflare login that opened it.
        if (identity) {
          const t = setTimeout(() => res.end(), Math.max(0, identity.exp * 1000 - Date.now()));
          req.on('close', () => clearTimeout(t));
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/update') {
        return send(res, 200, { ...updater.status(), canApply: !viaCloudflare && isLocal(req) });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const live = new Set(history.map((m) => m.id));
        return send(res, 200, {
          userName: settings.userName, defaultAgent: settings.defaultAgent,
          agents: agents.map(agentInfo), history,
          flags: Object.fromEntries(Object.entries(state.flags).filter(([id]) => live.has(id))),
          drafts: Object.fromEntries(agents.filter((a) => runtime[a.id].draft).map((a) => [a.id, runtime[a.id].draft])),
          usage: usage.summary(agents.map((a) => a.id)),
          schedules: scheduler.list(),
          modelChoices: MODEL_CHOICES, effortChoices: EFFORT_CHOICES,
          pushKey: push.publicKey,
          signedInAs: identity?.email || null,
          signOutUrl: viaCloudflare ? '/cdn-cgi/access/logout' : null,
        });
      }
      // Settings editor: this PC only, never over the tunnel or from other devices.
      if (req.method === 'GET' && url.pathname === '/api/config') {
        if (viaCloudflare || !isLocal(req)) return send(res, 403, { error: 'Settings can only be changed from the PC Crew runs on.' });
        return send(res, 200, { ...editableConfig(), supervised: process.env.CREW_SUPERVISED === '1', modelChoices: MODEL_CHOICES, effortChoices: EFFORT_CHOICES, permissionModes: PERMISSION_MODES });
      }
      if (req.method === 'GET' && url.pathname === '/api/machines/link') return send(res, 200, { url: rawCfg.presenceHub?.url || '' });
      if (req.method === 'GET' && url.pathname === '/api/source') {
        if (viaCloudflare || !isLocal(req)) return send(res, 403, { error: 'Source can only be viewed from the PC Crew runs on.' });
        return send(res, 200, await setup.sourceStatus(ROOT));
      }
      if (req.method === 'GET' && url.pathname === '/api/uninstall/preview') {
        if (viaCloudflare || !isLocal(req)) return send(res, 403, { error: 'Uninstall can only be started from the PC Crew runs on.' });
        try { return send(res, 200, uninstall.previewUninstall(ROOT, { dataMode: url.searchParams.get('dataMode') || 'backup' })); }
        catch (err) { return send(res, 400, { error: err.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/machines') {
        presence.setActivity(busyCount() ? `${busyCount()} agent${busyCount() > 1 ? 's' : ''} working` : 'idle');
        return send(res, 200, presence.list());
      }
      if (req.method === 'GET' && url.pathname === '/api/integrations') {
        return send(res, 200, await integrations.get(url.searchParams.get('refresh') === '1'));
      }
      if (req.method === 'GET' && url.pathname === '/api/prefs') {
        try { return send(res, 200, JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'))); } catch { return send(res, 200, {}); }
      }
      if (req.method === 'GET' && url.pathname === '/api/notes') {
        try { return send(res, 200, JSON.parse(fs.readFileSync(NOTES_PATH, 'utf8'))); } catch { return send(res, 200, {}); }
      }
      if (req.method === 'GET' && url.pathname === '/api/usage') {
        return send(res, 200, { ...usage.summary(agents.map((a) => a.id)), judgeEnabled: settings.judge?.enabled === true });
      }
      let mm;
      if (req.method === 'GET' && (mm = url.pathname.match(/^\/api\/changes\/([\w-]+)\/diff$/))) {
        const m = history.find((x) => x.id === mm[1]);
        if (!m?.changes?.repo) return send(res, 404, { error: 'No diff available for this message.' });
        return send(res, 200, { diff: await changes.diff(m.changes, url.searchParams.get('path') || '') });
      }
      if (req.method === 'GET' && (mm = url.pathname.match(/^\/api\/uploads\/([\w-]+)$/))) {
        const name = fs.readdirSync(UPLOAD_DIR).find((f) => f.startsWith(mm[1] + '__'));
        if (!name) return send(res, 404, { error: 'not found' });
        const ext = path.extname(name).slice(1).toLowerCase();
        const type = UPLOAD_TYPES[ext];
        res.writeHead(200, {
          'Content-Type': type || 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
          'Cache-Control': 'private, max-age=86400',
          ...(type && type.startsWith('image/') ? {} : { 'Content-Disposition': `attachment; filename="${name.split('__')[1].replace(/"/g, '')}"` }),
        });
        return res.end(fs.readFileSync(path.join(UPLOAD_DIR, name)));
      }

      if (req.method === 'POST') {
        // Custom header + JSON body: a random web page can't forge these without a CORS preflight we never answer.
        if (req.headers['x-crew'] !== '1') return send(res, 403, { error: 'missing header' });
        const origin = req.headers.origin;
        if (origin) {
          let originHost = '';
          try { originHost = new URL(origin).hostname.toLowerCase(); } catch { /* "null" etc. */ }
          if (!hosts.has(originHost)) return send(res, 403, { error: 'bad origin' });
        }

        // Attachments arrive as raw bytes, not JSON.
        if (url.pathname === '/api/upload') {
          const original = decodeURIComponent(String(req.headers['x-filename'] || 'file')).replace(/[^\w.\- ]+/g, '_').slice(-80) || 'file';
          const data = await readRaw(req, MAX_UPLOAD);
          if (!data.length) return send(res, 400, { error: 'empty file' });
          const id = crypto.randomUUID();
          const file = path.join(UPLOAD_DIR, `${id}__${original}`);
          fs.writeFileSync(file, data);
          return send(res, 200, { id, name: original, size: data.length, type: UPLOAD_TYPES[path.extname(original).slice(1).toLowerCase()] || 'application/octet-stream' });
        }

        const body = JSON.parse((await readBody(req)) || '{}');

        if (url.pathname === '/api/send') {
          let text = String(body.text || '').trim();
          // A leading "!" makes the message urgent: it skips the concurrency cap.
          const urgent = text.startsWith('!');
          if (urgent) text = text.replace(/^!+s*/, '');
          const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 10).map((id) => {
            const name = /^[\w-]+$/.test(String(id)) && fs.readdirSync(UPLOAD_DIR).find((f) => f.startsWith(id + '__'));
            if (!name) return null;
            const full = path.join(UPLOAD_DIR, name);
            return { id, name: name.split('__')[1], path: full, size: fs.statSync(full).size, type: UPLOAD_TYPES[path.extname(name).slice(1).toLowerCase()] || null };
          }).filter(Boolean);
          if (!text && !attachments.length) return send(res, 400, { error: 'empty' });
          const to = userTargets(text);
          const shown = attachments.map(({ path: _p, ...rest }) => rest);
          post({ from: 'user', text: text || '(attachment)', to, attachments: shown.length ? shown : undefined });
          for (const id of to) enqueue(id, { fromId: 'user', text: text || 'Please look at the attached file(s).', hop: 0, attachments, urgent });
          return send(res, 200, { ok: true, to });
        }
        // Update to the latest release. This PC only, like restart.
        if (url.pathname === '/api/update/apply') {
          if (viaCloudflare || !isLocal(req)) return send(res, 403, { error: 'Updating is only allowed from the PC Crew runs on.' });
          try {
            const r = await updater.apply();
            send(res, 200, r);
            if (r.restarting) {
              console.log('Restarting to finish the update');
              for (const a of agents) stopAgent(a.id);
              setTimeout(() => process.exit(0), 1500);
            }
          } catch (err) {
            send(res, 200, { ok: false, error: err.message });
          }
          return;
        }
        if (url.pathname === '/api/config') {
          if (viaCloudflare || !isLocal(req)) return send(res, 403, { error: 'Settings can only be changed from the PC Crew runs on.' });
          try {
            saveEditableConfig(body);
          } catch (err) {
            return send(res, 400, { error: err.message });
          }
          return send(res, 200, { ok: true, restartNeeded: true });
        }
        // Used by the tray icon. This PC only: never over the tunnel or from other devices.
        if (url.pathname === '/api/restart' && !viaCloudflare && isLocal(req)) {
          send(res, 200, { ok: true });
          console.log(`Restart requested at ${new Date().toLocaleString()}`);
          for (const a of agents) stopAgent(a.id);
          setTimeout(() => process.exit(0), 1500); // run-crew.cmd starts it again
          return;
        }
        if (url.pathname === '/api/source' && !viaCloudflare && isLocal(req)) {
          try {
            const next = await setup.switchSource(ROOT, { url: body.url, branch: body.branch });
            send(res, 200, { ok: true, ...next, restartNeeded: true });
          } catch (err) {
            return send(res, 409, { ok: false, error: err.message, dirtyFiles: err.dirtyFiles || [] });
          }
          return;
        }
        if (url.pathname === '/api/uninstall' && !viaCloudflare && isLocal(req)) {
          try {
            const dataMode = body.dataMode || 'backup';
            const preview = uninstall.previewUninstall(ROOT, { dataMode });
            if (body.dryRun) {
              const result = await uninstall.runUninstall({ installDir: ROOT, dataMode, dryRun: true, backupPath: body.backupPath || preview.backupPath });
              return send(res, 200, result);
            }
            // Backup first while this process is still running, then hand off deletion
            // to a detached setup-wizard so we don't delete our own files mid-request.
            let backup = null;
            if (dataMode === 'backup' && preview.userData.length) {
              backup = await uninstall.createBackupZip(ROOT, body.backupPath || preview.backupPath, preview.userData);
            }
            const planPath = path.join(DATA_DIR, 'uninstall-plan.json');
            fs.writeFileSync(planPath, JSON.stringify({
              installDir: ROOT, dataMode, backupPath: backup && backup.path, waitForPid: process.pid, createdAt: new Date().toISOString(),
            }, null, 2));
            const child = spawn(process.execPath, [path.join(ROOT, 'setup-wizard.js'), '--exec-plan', '--plan', planPath, '--dir', ROOT], {
              detached: true, stdio: 'ignore', cwd: ROOT,
            });
            child.unref();
            send(res, 200, { ok: true, handedOff: true, backup, planPath, preview });
            for (const a of agents) stopAgent(a.id);
            setTimeout(() => process.exit(0), 1500);
          } catch (err) {
            return send(res, 400, { ok: false, error: err.message });
          }
          return;
        }

        // ---- agents: stop, reset, model
        if ((mm = url.pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/(stop|reset|model|effort)$/)) && byId[mm[1]]) {
          const a = byId[mm[1]];
          if (mm[2] === 'stop') stopAgent(a.id);
          else if (mm[2] === 'reset') resetAgent(a);
          else if (mm[2] === 'effort') {
            const choice = body.effort || null;
            if (choice && !EFFORT_CHOICES.includes(choice)) return send(res, 400, { error: 'unknown effort' });
            if (choice) state.efforts[a.id] = choice; else delete state.efforts[a.id];
            saveState();
            broadcastAgent(a);
          } else {
            const choice = body.model || null;
            if (choice && !MODEL_CHOICES.includes(choice)) return send(res, 400, { error: 'unknown model' });
            if (choice) state.models[a.id] = choice; else delete state.models[a.id];
            saveState();
            broadcastAgent(a);
          }
          return send(res, 200, { ok: true, pending: runtime[a.id].resetPending });
        }

        if (url.pathname === '/api/refresh') {
          const a = byId[String(body.agent || '').toLowerCase()];
          if (!a) return send(res, 404, { error: 'Unknown agent.' });
          const out = await refreshAgent(a);
          return send(res, out.ok ? 200 : 409, out);
        }

        // ---- approve a permission an agent was refused, and let it continue
        if (url.pathname === '/api/approve') {
          const m = history.find((x) => x.id === body.id);
          if (!m?.denials?.length || !byId[m.from]) return send(res, 404, { error: 'Nothing to approve on that message.' });
          if (state.flags[m.id]?.approved) return send(res, 409, { error: 'Already approved.' });
          const a = byId[m.from];
          setFlag(m.id, { approved: Date.now() });
          const labels = m.denials.map((d) => d.label).join(', ');
          post({ from: 'user', text: `✅ Approved for ${a.name}: ${labels}`, to: [a.id] });
          enqueue(a.id, {
            fromId: 'user', hop: 0, allow: m.denials.map((d) => d.rule),
            text: `Approved: you may now ${labels}. Please continue where you left off.`,
          });
          return send(res, 200, { ok: true });
        }

        // ---- undo a turn's file changes
        if ((mm = url.pathname.match(/^\/api\/changes\/([\w-]+)\/undo$/))) {
          const m = history.find((x) => x.id === mm[1]);
          if (!m?.changes?.repo) return send(res, 404, { error: 'Undo isn\'t available for this message.' });
          if (state.flags[m.id]?.undone) return send(res, 409, { error: 'Already undone.' });
          const a = byId[m.from];
          if (a && runtime[a.id].busy) return send(res, 409, { error: `${a.name} is working right now. Stop it or wait, then undo.` });
          const result = await changes.undo(m.changes);
          setFlag(m.id, { undone: { at: Date.now(), ...result } });
          const skipped = result.skipped.length ? ` Skipped ${result.skipped.length}: ${result.skipped.map((s) => `${s.path} (${s.why})`).join('; ')}.` : '';
          post({ kind: 'system', text: `↩ Undid ${result.done.length} file change(s) from ${a?.name || 'that'} turn.${skipped}` });
          return send(res, 200, { ok: true, ...result });
        }

        // ---- judge: manual only, refuses unless switched on in Settings
        if (url.pathname === '/api/judge') {
          const r = await judge.ask(String(body.prompt || ''));
          return send(res, r.ok ? 200 : (r.disabled ? 403 : 500), r);
        }

        // ---- usage budget guard
        if (url.pathname === '/api/stopall') {
          for (const a of agents) stopAgent(a.id);
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/prefs') {
          const k = String(body.key || '');
          if (!/^crew-[\w-]{1,40}$/.test(k) || typeof body.value !== 'string' || body.value.length > 20000) return send(res, 400, { error: 'bad pref' });
          let all = {}; try { all = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch {}
          all[k] = body.value;
          fs.writeFileSync(PREFS_PATH, JSON.stringify(all, null, 2));
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/notes') {
          const g = String(body.group || '').slice(0, 60), items = Array.isArray(body.items) ? body.items.slice(0, 500) : null;
          if (!g || !items) return send(res, 400, { error: 'group and items required' });
          let all = {}; try { all = JSON.parse(fs.readFileSync(NOTES_PATH, 'utf8')); } catch {}
          all[g] = items.map((i) => ({ text: String(i.text || '').slice(0, 500), done: !!i.done }));
          fs.writeFileSync(NOTES_PATH, JSON.stringify(all, null, 2));
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/budget') {
          usage.setBudget(body);
          pump();
          broadcastUsage();
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/budget/override') {
          usage.override();
          post({ kind: 'system', text: 'Running held work anyway, until this usage window resets.' });
          pump();
          broadcastUsage();
          return send(res, 200, { ok: true });
        }

        // ---- scheduled jobs
        const ids = agents.map((a) => a.id);
        if (url.pathname === '/api/schedules') {
          try { scheduler.add(body, ids); } catch (e) { return send(res, 400, { error: e.message }); }
          broadcast('schedules', scheduler.list());
          return send(res, 200, { ok: true });
        }
        if ((mm = url.pathname.match(/^\/api\/schedules\/([\w-]+)(?:\/(delete|run))?$/))) {
          try {
            if (mm[2] === 'delete') scheduler.remove(mm[1]);
            else if (mm[2] === 'run') scheduler.runNow(mm[1]);
            else scheduler.update(mm[1], body, ids);
          } catch (e) { return send(res, 400, { error: e.message }); }
          broadcast('schedules', scheduler.list());
          return send(res, 200, { ok: true });
        }

        // ---- phone notifications
        // Machine pairing is managed from Settings: this PC only, never over the tunnel or from other devices.
        if (/^\/api\/machines\/(pair|connect|disconnect|remove)$/.test(url.pathname) && (viaCloudflare || !isLocal(req))) {
          return send(res, 403, { error: 'Machines can only be changed from the PC Crew runs on.' });
        }
        if (url.pathname === '/api/machines/pair') {
          const p = presence.newPairCode();
          // Address another PC should use to reach this hub: the Cloudflare name if set up, else this PC on the LAN.
          const hub = cf ? cf.hostname : settings.allowLan && lanAddresses()[0] ? lanAddresses()[0] + ':' + settings.port : '';
          const line = hub ? 'Install Claude Crew on the new PC (double-click setup.cmd). Then in Settings > Machines enter:\nHub: ' + hub + '\nCode: ' + p.code : '';
          return send(res, 200, { ...p, hub, line });
        }
        if (url.pathname === '/api/machines/connect') {
          try {
            const hubUrl = await pairOnce({ hubUrl: body.url, pairCode: body.code, cfClientId: body.cfClientId, cfClientSecret: body.cfClientSecret,
              file: presenceClientFile, name: rawCfg.machineName || os.hostname(), version: VERSION, activity: () => 'idle' });
            const hub = { url: hubUrl };
            if (body.cfClientId && body.cfClientSecret) { hub.cfClientId = body.cfClientId; hub.cfClientSecret = body.cfClientSecret; }
            savePresenceHub(hub);
            startPresenceClient(hub);
            return send(res, 200, { ok: true, url: hubUrl });
          } catch (e) { return send(res, 400, { error: e.message }); }
        }
        if (url.pathname === '/api/machines/disconnect') {
          clearInterval(presenceTimer);
          try { fs.unlinkSync(presenceClientFile); } catch { /* not paired */ }
          savePresenceHub(null);
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/machines/remove') { presence.remove(String(body.id || '')); return send(res, 200, { ok: true }); }
        if (url.pathname === '/api/push/subscribe') {
          try { push.subscribe(body.subscription || {}, body.label); } catch (e) { return send(res, 400, { error: e.message }); }
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/push/unsubscribe') {
          push.unsubscribe(String(body.endpoint || ''));
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/push/test') {
          if (!push.has(String(body.endpoint || ''))) return send(res, 404, { error: 'This device isn\'t subscribed.' });
          const r = await push.notify({ title: 'Claude Crew', body: 'Notifications are working on this device. 🎉', tag: 'crew-test', url: '/' }, { only: body.endpoint });
          return send(res, 200, { ok: true, status: r[0] });
        }
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  };
}

function writePid() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PID_PATH, JSON.stringify({ pid: process.pid, port: settings.port, root: ROOT, startedAt: new Date().toISOString() }));
  } catch (err) { console.log('Could not write PID file:', err.message); }
}
function clearPid() { try { fs.unlinkSync(PID_PATH); } catch { /* already gone */ } }
process.on('exit', clearPid);
process.on('SIGINT', () => { clearPid(); process.exit(0); });
process.on('SIGTERM', () => { clearPid(); process.exit(0); });

function listen(server, port, host, what) {
  return new Promise((resolve) => {
    server.on('error', (err) => {
      console.error(err.code === 'EADDRINUSE'
        ? `Port ${port} (${what}) is already in use. Is Crew already running? Otherwise change it in crew.config.json.`
        : err);
      process.exit(1);
    });
    server.listen(port, host, resolve);
  });
}

(async () => {
  const local = `http://localhost:${settings.port}`;
  await listen(http.createServer(makeHandler('local')), settings.port, settings.allowLan ? '0.0.0.0' : '127.0.0.1', 'local');
  writePid();
  if (cf) {
    // Loopback only: the tunnel runs on this PC, nothing else should reach this port.
    await listen(http.createServer(makeHandler('cloudflare')), cf.port, '127.0.0.1', 'Cloudflare');
  }

  scheduler.start();
  updater.start();
  if (rawCfg.presenceHub?.url) startPresenceClient(rawCfg.presenceHub);
  console.log(`\n  Claude Crew is running: ${local}`);
  console.log(`  Claude Code: ${CLAUDE}`);
  for (const a of agents) console.log(`  ${a.missing ? '!!' : '  '} @${a.id.padEnd(12)} ${a.cwd}${a.missing ? '  (folder not found)' : ''}`);
  if (settings.allowLan) {
    console.log('\n  From your phone (same Wi-Fi):');
    for (const ip of lanAddresses()) console.log(`    http://${ip}:${settings.port}`);
    console.log(`  Access key: ${state.accessKey}`);
  }
  if (cf) {
    console.log(`\n  Internet: https://${cf.hostname}  (Cloudflare tunnel -> http://localhost:${cf.port})`);
    console.log(`  Allowed: ${cf.allowedEmails.join(', ')}`);
    try {
      await loadAccessKeys(false);
      console.log(`  Cloudflare Access keys loaded from ${cf.teamDomain}`);
    } catch (err) {
      console.log(`  !! ${err.message}. Check "teamDomain" in crew.config.json.`);
    }
  }
  console.log(process.stdout.isTTY
    ? '\n  Leave this window open. Close it (or Ctrl+C) to stop Crew.\n'
    : '\n  Running in the background. Use the Crew tray icon to open or restart it.\n');
  if (process.argv.includes('--open')) {
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', local], () => {});
    else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [local], () => {});
  }
})();
