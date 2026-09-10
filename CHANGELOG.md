# Changelog

## 0.3.9

- `extensionKind` is now `["workspace"]` only. With the previous `["workspace", "ui"]`, a Remote-SSH window could also run a local instance whose status bar items shadowed the remote ones — showing the local machine's subscription meter and backend toggle while appearing to be the remote's. A remote window now always shows the remote host's state.

## 0.3.8

- Corrected backend precedence after empirical testing against Claude Code: the `~/.claude/settings.json` env value (what the toggle writes) is applied by Claude Code **over** the inherited process environment, so the toggle now always works — including on machines whose shell exports `CLAUDE_CODE_USE_BEDROCK`. The exported variable only decides when settings carry no value, and the tooltip says so in that case. Removes 0.3.7's "pinned by environment" refusal, which was based on the wrong precedence model.

## 0.3.7

- The backend toggle now shows the **effective** backend: when `CLAUDE_CODE_USE_BEDROCK` is set in the environment it wins (API icon for `1`, sub for `0`), otherwise the `~/.claude/settings.json` value applies. Previously the icon read only settings.json and could disagree with what Claude Code actually uses.
- When the environment variable pins the backend, clicking the toggle explains the pin (change/unset the export, restart the VS Code server) instead of writing a settings value that cannot take effect; the tooltip shows the pin too.

## 0.3.6

- The login command now opens the Claude Code panel's graphical login page (Claude.ai Subscription / Anthropic Console / Bedrock) when the Claude Code extension is installed; the terminal `claude /login` flow remains as the fallback.

## 0.3.5

- The login command marks CLI onboarding as completed (`~/.claude.json`) before running `claude /login`, so first-time logins start at the login step instead of the theme-picker sample-diff screen. An existing theme choice is never overridden, and the CLI's folder-trust safety prompt is left in place.

## 0.3.4

- The login command now finds the `claude` CLI even when it is not on PATH, by falling back to the binary bundled inside the installed Claude Code extension; if neither exists, it says so instead of opening a terminal that fails with "command not found".

## 0.3.3

- New **AI Meter: Log in to Claude (subscription)** command: opens a terminal running `claude /login` with `CLAUDE_CODE_USE_BEDROCK=0`, so login works even on machines whose shell environment pins Claude Code to Bedrock.
- Switching to subscription on a machine with no stored login now offers a **Log In** button on the toast, and the meter's no-credentials tooltip carries a clickable **Log in to Claude** link.

## 0.3.2

- Switching to API/Bedrock on a machine with no credentials now asks for confirmation in a modal dialog (Switch Anyway / Cancel) instead of only toasting after the fact.
- While API/Bedrock is selected without credentials, the toggle stays in a persistent warning state — amber background and a `$(warning)` icon — until credentials appear or the backend is switched back, so the broken configuration is visible in the status bar itself.

## 0.3.1

- Backend toggle shows a text label (`$(account) sub` / `$(cloud) API`) so the active backend and the click target are legible at a glance.
- Toggle and meter use adjacent fractional priorities (100.011 / 100.01) so other extensions' status bar items can no longer slot in between them.
- Switching to API/Bedrock warns when no credentials are found on the machine (no `~/.aws` credentials, `AWS_*` variables, or `ANTHROPIC_API_KEY`), and both the toast and the toggle tooltip note when an environment-exported `CLAUDE_CODE_USE_BEDROCK` (e.g. in `~/.bashrc`) shadows the settings.json value.

## 0.3.0

- Backend toggle button: a small status bar item (left of the meter) shows which backend a new Claude Code session will use — `$(account)` subscription (login) or `$(cloud)` API/Bedrock — and clicking it **switches Claude Code's backend** by writing `env.CLAUDE_CODE_USE_BEDROCK` in `~/.claude/settings.json` (preserving the rest of the file). Also available as **AI Meter: Switch Claude Code Backend (Subscription / API)**. Takes effect on the next Claude Code session (running sessions keep their auth); with `aiMeter.mode: auto` the meter's display follows the backend.
- Declared `extensionKind: ["workspace", "ui"]` so under Remote-SSH the meter and the backend toggle act on the **remote** `~/.claude/` (where remote Claude Code authenticates), and locally otherwise.

## 0.2.2

- Fix the status bar item staying invisible until a manual refresh when the extension activates during a Remote-SSH reconnect: the item now has a stable id/name and re-asserts `show()` shortly after activation.
- New "AI Meter" output channel logging mode and render decisions, for diagnosing display issues.

## 0.2.1

- Cost mode status bar now shows the current model and today's usage only (`opus-5 5.2M $18.9`); the 5h session figure moved to the tooltip.
- Cost mode tooltip: last-7-day usage bar chart (tokens and estimated cost per day).

## 0.2.0

- Cost mode: session (5h) and today token totals with estimated spend, computed locally from Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) at Anthropic list prices, with a per-model breakdown in the tooltip. Auto-activates when Claude Code is configured for Bedrock (`CLAUDE_CODE_USE_BEDROCK` in the environment or `~/.claude/settings.json`); force with the new `aiMeter.mode` setting (`auto`/`subscription`/`cost`).

## 0.1.5

- Recover automatically after `claude` login: the fast startup retry now also covers missing/expired credentials (cheap — no HTTP request is made without a token), and a watcher on `~/.claude/.credentials.json` triggers an immediate re-poll when the file changes.

## 0.1.4

- Status bar: plain text segments (no chip caps) — `4.7h 100% 5.3d 99% fable 99%`.

## 0.1.3

- Status bar chips: countdown and model rendered with solid half-block caps (▐4.7h▌) instead of brackets.

## 0.1.2

- Status bar: reset countdown rendered as a leading `[4.7h]` / `[5.3d]` card per limit; model-scoped weekly no longer repeats the weekly countdown.

## 0.1.1

- Compact tooltip: one line per limit, tighter line spacing.

## 0.1.0

- Initial release, extracted from the fennets console extension.
- Status bar gauge for the Claude 5-hour session, weekly, and model-scoped weekly limits.
- Markdown tooltip with fuel-tank bars and reset times; warning/error highlight when a limit runs low.
- Reads the Claude Code OAuth token from `~/.claude/.credentials.json` (or the macOS Keychain); caches the last reading in extension global state.
