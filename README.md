# AI Meter

Claude subscription usage — the 5-hour session limit and weekly limits — as a live gauge in the VS Code status bar.

```
⊞ 5h 74% 4.2h · wk 77% 1.6d · opus 62% 3.1d
```

Each segment is one rate limit: percent **remaining** and time until the limit resets. Hover for fuel-tank gauges with exact reset times; the item turns amber/red when any limit runs low.

## How it works

AI Meter reuses the OAuth token that [Claude Code](https://claude.com/claude-code) stores after you log in (`~/.claude/.credentials.json`, or the Keychain on macOS) and polls Anthropic's usage endpoint (`api.anthropic.com/api/oauth/usage`) every 5 minutes. The last reading is cached, so the gauge appears instantly after a window reload.

- No account setup of its own — if Claude Code works, AI Meter works.
- The token is read locally and sent only to `api.anthropic.com`. Nothing else is collected or transmitted.
- If no credentials are found (or the token expired), the item shows `—` with an explanatory tooltip. Run Claude Code once to log in / refresh.

## Requirements

- Claude Code logged in with a Claude subscription (Pro / Max / Team). API-key-only and Bedrock/Vertex setups have no subscription quota to report.

## Settings

| Setting | Default | Description |
|---|---|---|
| `aiMeter.pollMinutes` | `5` | Poll interval in minutes. |
| `aiMeter.display` | `remaining` | Show percent remaining (fuel-tank style) or percent `used`. |
| `aiMeter.showModelWeekly` | `true` | Also show the model-scoped weekly limit (e.g. Opus) when reported. |
| `aiMeter.warnBelow` | `25` | Warning highlight when any limit has less than this % remaining. |
| `aiMeter.errorBelow` | `10` | Error highlight when any limit has less than this % remaining. |
| `aiMeter.hideWhenUnavailable` | `false` | Hide the item entirely when no credentials are found. |

## Commands

- **AI Meter: Refresh Usage** — also bound to clicking the status bar item.

## Development

```bash
# run: open this folder in VS Code, press F5 (Extension Development Host)

# package
npx @vscode/vsce package
```
