// AI Meter — Claude subscription usage in the VS Code status bar.
//
// Data source: the Claude Code OAuth token (~/.claude/.credentials.json, or
// the macOS Keychain), used to call GET api.anthropic.com/api/oauth/usage.
// Nothing else is read and no data leaves the machine except that one request.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const CACHE_KEY = 'aiMeter.limits';
const POLL_RETRY_MS = 15000; // fast retry until the first successful fetch

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
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'aiMeter.refresh';
  context.subscriptions.push(item);

  let limits = context.globalState.get(CACHE_KEY) || null;
  let lastError = null;
  let fetchedAt = context.globalState.get(CACHE_KEY + '.at') || null;

  function cfg() { return vscode.workspace.getConfiguration('aiMeter'); }

  function render() {
    const c = cfg();
    if (!limits) {
      if (lastError === 'no-credentials' && c.get('hideWhenUnavailable')) { item.hide(); return; }
      item.text = '$(dashboard) —';
      item.backgroundColor = undefined;
      item.tooltip = new vscode.MarkdownString(
        lastError === 'no-credentials' ? 'AI Meter: no Claude credentials found (`~/.claude/.credentials.json`). Log in with Claude Code first.'
        : lastError === 'token-expired' ? 'AI Meter: Claude OAuth token expired — run Claude Code once to refresh it.'
        : 'AI Meter: usage unavailable' + (lastError ? ' (' + lastError + ')' : '') + '. Click to retry.');
      item.show();
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
    item.show();
  }

  let retryTimer = null;
  function poll() {
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

  render(); // show cached data immediately on reload
  poll();

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
    { dispose: () => { clearInterval(pollTimer); if (retryTimer) clearInterval(retryTimer); clearTimeout(credDebounce); if (credWatcher) credWatcher.close(); } },
    vscode.commands.registerCommand('aiMeter.refresh', poll),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('aiMeter')) return;
      clearInterval(pollTimer);
      pollTimer = setInterval(poll, cfg().get('pollMinutes') * 60000);
      render();
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
