# Changelog

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
