# Changelog

## 0.1.0

- Initial release, extracted from the fennets console extension.
- Status bar gauge for the Claude 5-hour session, weekly, and model-scoped weekly limits.
- Markdown tooltip with fuel-tank bars and reset times; warning/error highlight when a limit runs low.
- Reads the Claude Code OAuth token from `~/.claude/.credentials.json` (or the macOS Keychain); caches the last reading in extension global state.
