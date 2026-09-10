// AI Meter — Claude usage in the VS Code status bar.
//
// Two modes:
//  - subscription: the Claude Code OAuth token (~/.claude/.credentials.json, or
//    the macOS Keychain) is used to call GET api.anthropic.com/api/oauth/usage.
//    Nothing else is read and no data leaves the machine except that one request.
//  - cost: session tokens and estimated spend, computed locally from the
//    Claude Code transcripts under ~/.claude/projects/. Nothing leaves the
//    machine at all. Auto-selected when Claude Code is configured for Bedrock
//    (CLAUDE_CODE_USE_BEDROCK), where there are no subscription limits to show.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const CACHE_KEY = 'aiMeter.limits';
const POLL_RETRY_MS = 15000; // fast retry until the first successful fetch
const SESSION_MS = 5 * 3600000; // "session" = the last 5 hours, matching Claude's session window

/** Read the Claude Code OAuth credentials. Returns {accessToken, expiresAt} or null. */
function readCredentials() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    const creds = JSON.parse(raw).claudeAiOauth;
    if (creds && creds.accessToken) return creds;
  } catch (_) { /* fall through */ }
  if (process.platform === 'darwin') {
    // Claude Code on macOS stores credentials in the Keychain.
    try {
      const raw = execFileSync('security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 5000 });
      const creds = JSON.parse(raw).claudeAiOauth;
      if (creds && creds.accessToken) return creds;
    } catch (_) { /* no keychain entry */ }
  }
  return null;
}

/**
 * Fetch usage limits. cb(limits, errKind) where limits is
 * [{kind: 'session'|'weekly_all'|'weekly_scoped', percent, resetsAt, model}]
 * and errKind is null | 'no-credentials' | 'token-expired' | 'network' | 'bad-response'.
 */
function fetchUsage(cb) {
  const creds = readCredentials();
  if (!creds) return cb(null, 'no-credentials');
  if (creds.expiresAt && creds.expiresAt < Date.now()) return cb(null, 'token-expired');

  const req = https.get({
    hostname: 'api.anthropic.com',
    path: '/api/oauth/usage',
    headers: {
      'Authorization': 'Bearer ' + creds.accessToken,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    timeout: 10000,
  }, res => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => {
      try {
        const j = JSON.parse(body);
        const limits = [];
        if (j.limits) {
          // Legacy shape: {limits: [{kind, percent, resets_at, scope}]}
          for (const l of j.limits) {
            limits.push({
              kind: l.kind,
              percent: l.percent,
              resetsAt: l.resets_at,
              model: l.scope && l.scope.model ? l.scope.model.display_name : null,
            });
          }
        } else {
          // Current shape: {five_hour: {utilization, resets_at}, seven_day: {...},
          // seven_day_opus / seven_day_sonnet: model-scoped or null}
          if (j.five_hour) limits.push({ kind: 'session', percent: j.five_hour.utilization, resetsAt: j.five_hour.resets_at, model: null });
          if (j.seven_day) limits.push({ kind: 'weekly_all', percent: j.seven_day.utilization, resetsAt: j.seven_day.resets_at, model: null });
          if (j.seven_day_opus) limits.push({ kind: 'weekly_scoped', percent: j.seven_day_opus.utilization, resetsAt: j.seven_day_opus.resets_at, model: 'Opus' });
          if (j.seven_day_sonnet) limits.push({ kind: 'weekly_scoped', percent: j.seven_day_sonnet.utilization, resetsAt: j.seven_day_sonnet.resets_at, model: 'Sonnet' });
        }
        if (limits.length > 0) return cb(limits, null);
        cb(null, 'bad-response');
      } catch (_) {
        cb(null, 'bad-response');
      }
    });
  });
  req.on('error', () => cb(null, 'network'));
  req.on('timeout', () => { req.destroy(); });
}

// ---------------------------------------------------------------------------
// Cost mode — parse Claude Code transcripts and price the token usage.

/** True when Claude Code is configured to use Amazon Bedrock. */
function bedrockConfigured() {
  let v = process.env.CLAUDE_CODE_USE_BEDROCK;
  if (v === undefined) {
    for (const f of ['settings.json', 'settings.local.json']) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', f), 'utf8'));
        if (j && j.env && j.env.CLAUDE_CODE_USE_BEDROCK !== undefined) {
          v = String(j.env.CLAUDE_CODE_USE_BEDROCK);
          break;
        }
      } catch (_) { /* missing or unparsable settings file */ }
    }
  }
  return !!v && v !== '0' && v !== 'false';
}

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

/** True when ~/.claude/settings.json's env turns Bedrock on. This is the value
 * the toggle writes and a new Claude Code session reads — the source of truth
 * for "what will the next session use", independent of the current process env. */
function settingsBedrockOn() {
  try {
    const j = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
    const v = j && j.env ? j.env.CLAUDE_CODE_USE_BEDROCK : undefined;
    return v !== undefined && String(v) !== '0' && String(v) !== 'false';
  } catch (_) { return false; }
}

/** Set env.CLAUDE_CODE_USE_BEDROCK in ~/.claude/settings.json, preserving the
 * rest of the file. Controls whether the NEXT Claude Code session uses
 * Bedrock/API (on) or the subscription login (off). Throws on write failure. */
function setBedrockSetting(on) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')) || {}; } catch (_) { j = {}; }
  if (!j.env || typeof j.env !== 'object') j.env = {};
  j.env.CLAUDE_CODE_USE_BEDROCK = on ? '1' : '0';
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(j, null, 2) + '\n');
}

/** Rough check that this machine has credentials for the API/Bedrock backend:
 * an Anthropic API key, a Bedrock bearer token, or any AWS credential source. */
function apiCredentialsPresent() {
  if (process.env.ANTHROPIC_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK ||
      process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) return true;
  for (const f of ['credentials', 'config']) {
    try { fs.accessSync(path.join(os.homedir(), '.aws', f)); return true; } catch (_) { /* keep looking */ }
  }
  return false;
}

// Anthropic list prices, $/MTok [input, output]. Cache write bills at input
// ×1.25 (5m TTL) or ×2 (1h TTL); cache read at input ×0.1. Bedrock model ids
// carry prefixes (us.anthropic.claude-...), so match by substring. First
// match wins — order specific patterns before generic ones.
const PRICES = [
  [/fable|mythos/, [10, 50]],
  [/haiku-4/, [1, 5]],
  [/haiku-3-5/, [0.8, 4]],
  [/haiku/, [0.25, 1.25]],
  [/opus-4-[01]-|opus-3/, [15, 75]],
  [/opus/, [5, 25]],
  [/sonnet/, [3, 15]],
];

function priceFor(model) {
  for (const [re, p] of PRICES) if (re.test(model)) return p;
  return null;
}

/** Estimated $ cost of one usage record ({input, output, cacheRead, cacheW5, cacheW1}). */
function recordCost(model, r) {
  const p = priceFor(model);
  if (!p) return 0;
  const [inP, outP] = p;
  return (r.input * inP + r.output * outP + r.cacheRead * inP * 0.1 +
    r.cacheW5 * inP * 1.25 + r.cacheW1 * inP * 2) / 1e6;
}

/** Parse one transcript JSONL line into a usage record, or null. */
function parseUsageLine(line) {
  if (line.indexOf('"usage"') === -1) return null;
  let e;
  try { e = JSON.parse(line); } catch (_) { return null; }
  if (!e || e.type !== 'assistant' || !e.message) return null;
  const m = e.message, u = m.usage;
  if (!u || !m.id) return null;
  const cc = u.cache_creation || {};
  const w1 = cc.ephemeral_1h_input_tokens || 0;
  const r = {
    id: m.id,
    ts: new Date(e.timestamp).getTime(),
    model: m.model || 'unknown',
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    // without a TTL breakdown, assume the cheaper 5m write rate
    cacheW5: Math.max(0, (u.cache_creation_input_tokens || 0) - w1),
    cacheW1: w1,
  };
  if (!(r.ts > 0)) return null;
  if (r.input + r.output + r.cacheRead + r.cacheW5 + r.cacheW1 === 0) return null; // synthetic entries
  return r;
}

// Transcript files are append-only JSONL; remember how far each was parsed so
// each poll only reads the appended bytes. One message produces one line per
// content block, all sharing message.id with identical usage — dedupe on id.
const fileCache = new Map(); // path -> {offset, tail, records}

function readAppended(fp, c, size) {
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.alloc(size - c.offset);
    fs.readSync(fd, buf, 0, buf.length, c.offset);
    c.offset = size;
    const lines = (c.tail + buf.toString('utf8')).split('\n');
    c.tail = lines.pop();
    const ids = new Set(c.records.map(r => r.id));
    for (const line of lines) {
      const r = parseUsageLine(line);
      if (r && !ids.has(r.id)) { ids.add(r.id); c.records.push(r); }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** All usage records at or after cutoffMs, across every project transcript. */
function collectRecords(cutoffMs) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files = new Set();
  let projects;
  try { projects = fs.readdirSync(root); } catch (_) { return []; }
  for (const proj of projects) {
    let names;
    try { names = fs.readdirSync(path.join(root, proj)); } catch (_) { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const fp = path.join(root, proj, n);
      let st;
      try { st = fs.statSync(fp); } catch (_) { continue; }
      if (st.mtimeMs < cutoffMs) continue;
      files.add(fp);
      let c = fileCache.get(fp);
      if (!c || st.size < c.offset) c = { offset: 0, tail: '', records: [] };
      try {
        if (st.size > c.offset) readAppended(fp, c, st.size);
      } catch (_) { /* transient read error — retry next poll */ }
      c.records = c.records.filter(r => r.ts >= cutoffMs);
      fileCache.set(fp, c);
    }
  }
  for (const fp of fileCache.keys()) if (!files.has(fp)) fileCache.delete(fp);
  const seen = new Set(), out = [];
  for (const fp of files) {
    for (const r of fileCache.get(fp).records) {
      if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
    }
  }
  return out;
}

/** Short display name: "us.anthropic.claude-opus-5" → "opus-5", "claude-haiku-4-5-20251001" → "haiku-4-5". */
function shortModel(model) {
  return String(model).replace(/^.*claude-/, '').replace(/-v\d+:\d+$/, '').replace(/-\d{8}$/, '');
}

/** Token totals and estimated cost for the 5h session, today, and the last 7 days. */
function computeCostStats() {
  const now = Date.now();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const dayStart = midnight.getTime();
  const sessionStart = now - SESSION_MS;
  const days = []; // oldest first, 7 entries ending today
  for (let i = 6; i >= 0; i--) {
    const d = new Date(midnight);
    d.setDate(d.getDate() - i);
    days.push({ start: d.getTime(), label: d.toLocaleDateString([], { weekday: 'short' }), tokens: 0, cost: 0 });
  }
  const stats = {
    session: { tokens: 0, cost: 0 },
    today: { tokens: 0, cost: 0 },
    days,
    latestModel: null, // model of the most recent request
    models: new Map(), // today, model -> {input, output, cacheRead, cacheWrite, cost, unpriced}
  };
  let latestTs = 0;
  for (const r of collectRecords(Math.min(days[0].start, sessionStart))) {
    const cost = recordCost(r.model, r);
    const tokens = r.input + r.output + r.cacheRead + r.cacheW5 + r.cacheW1;
    if (r.ts > latestTs) { latestTs = r.ts; stats.latestModel = r.model; }
    if (r.ts >= sessionStart) { stats.session.tokens += tokens; stats.session.cost += cost; }
    for (let i = days.length - 1; i >= 0; i--) {
      if (r.ts >= days[i].start) { days[i].tokens += tokens; days[i].cost += cost; break; }
    }
    if (r.ts >= dayStart) {
      stats.today.tokens += tokens;
      stats.today.cost += cost;
      let m = stats.models.get(r.model);
      if (!m) stats.models.set(r.model, m = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: !priceFor(r.model) });
      m.input += r.input;
      m.output += r.output;
      m.cacheRead += r.cacheRead;
      m.cacheWrite += r.cacheW5 + r.cacheW1;
      m.cost += cost;
    }
  }
  return stats;
}

function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

function fmtUsd(n) {
  return '$' + (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
}

// ---------------------------------------------------------------------------

function labelFor(limit) {
  if (limit.kind === 'session') return '5h';
  if (limit.kind === 'weekly_all') return 'wk';
  return limit.model ? limit.model.toLowerCase() : limit.kind;
}

/** '43m' / '4.2h' / '1.6d', or '' when the reset is in the past/unparsable. */
function fmtEta(resetsAt) {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!(ms > 0)) return '';
  if (ms < 3600000) return Math.max(1, Math.round(ms / 60000)) + 'm';
  if (ms < 86400000) return (ms / 3600000).toFixed(1) + 'h';
  return (ms / 86400000).toFixed(1) + 'd';
}

function fmtResetTime(limit) {
  try {
    const d = new Date(limit.resetsAt);
    return limit.kind === 'session'
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (_) {
    return String(limit.resetsAt);
  }
}

function tankBar(remaining) {
  const cells = 10;
  const filled = Math.round(Math.max(0, Math.min(100, remaining)) / 100 * cells);
  return '▮'.repeat(filled) + '▯'.repeat(cells - filled);
}

function activate(context) {
  // Explicit id + name: keeps the entry's identity stable across extension
  // host restarts and names it in the status bar context menu.
  const item = vscode.window.createStatusBarItem('aiMeter.usage', vscode.StatusBarAlignment.Right, 100.01);
  item.name = 'AI Meter';
  item.command = 'aiMeter.refresh';
  // A small toggle button sitting just left of the meter (higher priority =
  // further left on the right side; the 0.001 gap between the two priorities
  // keeps other extensions' items from slotting in between). Shows the active
  // mode; clicking flips subscription <-> cost so you don't have to edit settings.
  const toggle = vscode.window.createStatusBarItem('aiMeter.mode', vscode.StatusBarAlignment.Right, 100.011);
  toggle.name = 'AI Meter Mode';
  toggle.command = 'aiMeter.toggleMode';
  const out = vscode.window.createOutputChannel('AI Meter');
  context.subscriptions.push(item, toggle, out);
  const log = msg => out.appendLine(new Date().toLocaleTimeString() + ' ' + msg);
  let visible = false; // what render() last decided, so re-shows never override a hide()
  const show = () => { visible = true; updateToggle(); item.show(); toggle.show(); };
  const hide = () => { visible = false; item.hide(); toggle.hide(); };

  let limits = context.globalState.get(CACHE_KEY) || null;
  let lastError = null;
  let fetchedAt = context.globalState.get(CACHE_KEY + '.at') || null;
  let costStats = null;
  let activeMode = 'subscription';

  function cfg() { return vscode.workspace.getConfiguration('aiMeter'); }

  function resolveMode() {
    const m = cfg().get('mode') || 'auto';
    if (m === 'auto') return bedrockConfigured() ? 'cost' : 'subscription';
    return m;
  }

  // The toggle button reflects the Claude Code BACKEND that a new session will
  // use (from ~/.claude/settings.json), and clicking it flips that backend.
  // account = subscription/login, cloud = API/Bedrock.
  function updateToggle() {
    const shadowNote = process.env.CLAUDE_CODE_USE_BEDROCK !== undefined
      ? '\n\n⚠ `CLAUDE_CODE_USE_BEDROCK` is also set in this machine\'s environment (e.g. `~/.bashrc`) — that value overrides this setting in shells that export it.'
      : '';
    if (settingsBedrockOn()) {
      if (apiCredentialsPresent()) {
        toggle.text = '$(cloud) API';
        toggle.backgroundColor = undefined;
        toggle.tooltip = new vscode.MarkdownString(
          'Claude Code backend: **API / Bedrock**.\n\nClick to switch to **subscription (login)** for the next session. Running sessions keep their current auth.' + shadowNote);
      } else {
        // API selected but nothing to authenticate with — keep the item in a
        // warning state so the broken configuration stays visible, not just a toast.
        toggle.text = '$(cloud) API $(warning)';
        toggle.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        toggle.tooltip = new vscode.MarkdownString(
          '⚠ Claude Code backend: **API / Bedrock**, but **no credentials were found** on this machine (no `~/.aws` credentials, `AWS_*` variables, or `ANTHROPIC_API_KEY`) — the next Claude Code session may fail to authenticate.\n\nClick to switch back to **subscription (login)**.' + shadowNote);
      }
    } else {
      toggle.text = '$(account) sub';
      toggle.backgroundColor = undefined;
      toggle.tooltip = new vscode.MarkdownString(
        'Claude Code backend: **subscription (login)**.\n\nClick to switch to **API / Bedrock** for the next session. Running sessions keep their current auth.' + shadowNote);
    }
  }

  function renderCost() {
    if (!costStats) {
      item.text = '$(dashboard) —';
      item.backgroundColor = undefined;
      item.tooltip = 'AI Meter: cost mode — no data yet. Click to refresh.';
      show();
      return;
    }
    const s = costStats;
    item.text = '$(dashboard) ' + (s.latestModel ? shortModel(s.latestModel) + ' ' : '') +
      fmtTok(s.today.tokens) + ' ' + fmtUsd(s.today.cost);
    log('render cost: ' + item.text);
    item.backgroundColor = undefined;

    const md = new vscode.MarkdownString();
    md.appendMarkdown('**Claude cost** — estimated from local transcripts  \n');
    md.appendMarkdown('**Session (5h)** ' + fmtTok(s.session.tokens) + ' tokens · ≈' + fmtUsd(s.session.cost) + '  \n');
    md.appendMarkdown('**Today** ' + fmtTok(s.today.tokens) + ' tokens · ≈' + fmtUsd(s.today.cost) +
      (s.latestModel ? ' · current model `' + shortModel(s.latestModel) + '`' : '') + '  \n');
    md.appendMarkdown('\n**Last 7 days**\n');
    const maxCost = Math.max(0.000001, ...s.days.map(d => d.cost));
    const week = s.days.map(d => {
      const bar = '▇'.repeat(Math.round(d.cost / maxCost * 20)).padEnd(20, '·');
      return d.label + ' ' + bar + ' ' + fmtTok(d.tokens).padStart(6) + ' ' + fmtUsd(d.cost).padStart(6);
    });
    md.appendCodeblock(week.join('\n'), 'text');
    if (s.models.size > 0) {
      md.appendMarkdown('\n');
      const rows = [...s.models.entries()].sort((a, b) => b[1].cost - a[1].cost);
      for (const [model, m] of rows) {
        md.appendMarkdown('`' + model + '` in ' + fmtTok(m.input) + ' · out ' + fmtTok(m.output) +
          ' · cache r ' + fmtTok(m.cacheRead) + ' w ' + fmtTok(m.cacheWrite) +
          ' · ' + (m.unpriced ? 'no price data' : '≈' + fmtUsd(m.cost)) + '  \n');
      }
    } else {
      md.appendMarkdown('\nNo Claude Code activity today (`~/.claude/projects`).  \n');
    }
    md.appendMarkdown('\n_Priced at Anthropic list rates — Bedrock/partner billing may differ. ');
    if (fetchedAt) md.appendMarkdown('Updated ' + new Date(fetchedAt).toLocaleTimeString() + ' · ');
    md.appendMarkdown('click to refresh_');
    item.tooltip = md;
    show();
  }

  function render() {
    if (activeMode === 'cost') { renderCost(); return; }
    const c = cfg();
    if (!limits) {
      if (lastError === 'no-credentials' && c.get('hideWhenUnavailable')) { hide(); return; }
      item.text = '$(dashboard) —';
      item.backgroundColor = undefined;
      item.tooltip = new vscode.MarkdownString(
        lastError === 'no-credentials' ? 'AI Meter: no Claude credentials found (`~/.claude/.credentials.json`). Log in with Claude Code first. (Using Bedrock? Set `aiMeter.mode` to `cost`.)'
        : lastError === 'token-expired' ? 'AI Meter: Claude OAuth token expired — run Claude Code once to refresh it.'
        : 'AI Meter: usage unavailable' + (lastError ? ' (' + lastError + ')' : '') + '. Click to retry.');
      show();
      return;
    }

    const showModel = c.get('showModelWeekly');
    const showRemaining = c.get('display') !== 'used';
    const shown = limits.filter(l => showModel || l.kind !== 'weekly_scoped');

    const weeklyAll = shown.find(l => l.kind === 'weekly_all');
    const sameReset = (a, b) =>
      Math.abs(new Date(a.resetsAt).getTime() - new Date(b.resetsAt).getTime()) < 60000;
    const segs = [];
    let minRemaining = 100;
    for (const l of shown) {
      const remaining = Math.max(0, 100 - (l.percent || 0));
      minRemaining = Math.min(minRemaining, remaining);
      const pct = showRemaining ? remaining : Math.round(l.percent || 0);
      const eta = fmtEta(l.resetsAt);
      if (l.kind === 'weekly_scoped' && weeklyAll && sameReset(l, weeklyAll)) {
        // Model-scoped weekly resets together with the overall weekly —
        // skip the duplicate countdown, show just the model name.
        segs.push((l.model || l.kind).toLowerCase() + ' ' + pct + '%');
      } else {
        segs.push((eta || labelFor(l)) + ' ' + pct + '%');
      }
    }
    item.text = '$(dashboard) ' + segs.join(' ');
    log('render subscription: ' + item.text);

    if (minRemaining < c.get('errorBelow')) {
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (minRemaining < c.get('warnBelow')) {
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      item.backgroundColor = undefined;
    }

    const md = new vscode.MarkdownString();
    md.appendMarkdown('**Claude usage** — ' + (showRemaining ? 'percent remaining' : 'percent used') + '  \n');
    const rows = shown.map(l => {
      const remaining = Math.max(0, 100 - (l.percent || 0));
      const name = l.kind === 'session' ? '5h session'
        : l.kind === 'weekly_all' ? 'Weekly'
        : 'Weekly ' + (l.model || 'model');
      const dot = remaining < 10 ? '🔴' : remaining < 25 ? '🟡' : '🟢';
      return dot + ' `' + tankBar(remaining) + '` **' + name + '** ' + remaining + '% · resets ' + fmtResetTime(l) +
        (fmtEta(l.resetsAt) ? ' (' + fmtEta(l.resetsAt) + ')' : '');
    });
    md.appendMarkdown(rows.join('  \n'));
    if (fetchedAt) {
      md.appendMarkdown('  \n_Updated ' + new Date(fetchedAt).toLocaleTimeString() + ' · click to refresh_');
    }
    item.tooltip = md;
    show();
  }

  let retryTimer = null;
  function poll() {
    activeMode = resolveMode();
    log('poll (mode ' + activeMode + ')');
    if (activeMode === 'cost') {
      try {
        costStats = computeCostStats();
        fetchedAt = Date.now();
        lastError = null;
      } catch (_) {
        lastError = 'cost-scan';
      }
      if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
      render();
      return;
    }
    fetchUsage((fresh, err) => {
      lastError = err;
      if (fresh) {
        limits = fresh;
        fetchedAt = Date.now();
        context.globalState.update(CACHE_KEY, fresh);
        context.globalState.update(CACHE_KEY + '.at', fetchedAt);
        if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
      } else if (!limits && !retryTimer) {
        // Nothing cached yet — retry fast until the first success, then fall
        // back to the regular poll interval. Credential errors are included:
        // they are cheap to retry (no HTTP request is made), and this covers
        // the race where `claude auth login` rewrites the credentials file
        // moments after the extension's startup poll.
        retryTimer = setInterval(poll, POLL_RETRY_MS);
      }
      render();
    });
  }

  log('activated');
  render(); // show cached data immediately on reload
  poll();

  // Re-assert visibility a few times after activation. When the extension
  // host starts during a Remote-SSH reconnect, the first show() can be lost by
  // the window and the item stays invisible until the next poll.
  const reshowTimers = [2000, 10000, 60000].map(ms => setTimeout(() => { if (visible) { item.show(); toggle.show(); } }, ms));

  // Re-poll as soon as the credentials file changes, so a `claude auth
  // logout`/`login` cycle recovers instantly instead of waiting out a timer.
  let credWatcher = null;
  let credDebounce = null;
  try {
    credWatcher = fs.watch(path.join(os.homedir(), '.claude'), (_event, filename) => {
      if (filename && filename !== '.credentials.json') return;
      clearTimeout(credDebounce);
      credDebounce = setTimeout(poll, 1000); // debounce: login writes the file more than once
    });
  } catch (_) { /* ~/.claude missing (or fs.watch unsupported) — polling still covers it */ }

  let pollTimer = setInterval(poll, cfg().get('pollMinutes') * 60000);
  context.subscriptions.push(
    { dispose: () => { clearInterval(pollTimer); if (retryTimer) clearInterval(retryTimer); clearTimeout(credDebounce); reshowTimers.forEach(clearTimeout); if (credWatcher) credWatcher.close(); } },
    vscode.commands.registerCommand('aiMeter.refresh', poll),
    vscode.commands.registerCommand('aiMeter.toggleMode', async () => {
      // Switch the Claude Code auth backend for the NEXT session by flipping
      // env.CLAUDE_CODE_USE_BEDROCK in ~/.claude/settings.json. Running sessions
      // keep their auth; a new `claude` session reads the new value.
      const on = settingsBedrockOn();
      if (!on && !apiCredentialsPresent()) {
        // About to select API/Bedrock with nothing to authenticate with —
        // confirm via a modal so the problem can't be missed or buried.
        const pick = await vscode.window.showWarningMessage(
          'No Bedrock/API credentials found on this machine — no ~/.aws credentials, AWS_* variables, or ANTHROPIC_API_KEY. The next Claude Code session would fail to authenticate.',
          { modal: true, detail: 'Switch to API / Bedrock anyway? The toggle will stay highlighted until credentials are configured.' },
          'Switch Anyway');
        if (pick !== 'Switch Anyway') { log('toggle backend cancelled (no API credentials)'); return; }
      }
      try {
        setBedrockSetting(!on);
      } catch (e) {
        vscode.window.showErrorMessage('AI Meter: could not update ' + CLAUDE_SETTINGS + ' — ' + e.message);
        return;
      }
      const to = !on ? 'API / Bedrock' : 'subscription (login)';
      log('toggle backend -> CLAUDE_CODE_USE_BEDROCK=' + (!on ? '1' : '0'));
      let msg = 'Claude Code will use ' + to + ' on its next session (start a new session to apply). Running sessions keep their current auth.';
      if (process.env.CLAUDE_CODE_USE_BEDROCK !== undefined) {
        msg += ' Note: CLAUDE_CODE_USE_BEDROCK is also set in this machine\'s environment (e.g. ~/.bashrc), which overrides this setting in shells that export it.';
      }
      vscode.window.showInformationMessage(msg);
      updateToggle();
      poll(); // AI Meter display follows when aiMeter.mode is "auto"
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('aiMeter')) return;
      clearInterval(pollTimer);
      pollTimer = setInterval(poll, cfg().get('pollMinutes') * 60000);
      poll(); // mode may have changed
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
