<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd on Desk (Enhanced Fork)</h1>
<p align="center">
  <a href="README.zh-CN.md">中文版</a> · <a href="https://github.com/rullerzhou-afk/clawd-on-desk">Upstream</a>
</p>

> This is a **personal fork** of [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) by [@rullerzhou-afk](https://github.com/rullerzhou-afk). It adds power-user features on top of the original while staying compatible with upstream updates.

A desktop pet that reacts to your AI coding agent sessions in real-time. Clawd lives on your screen — thinking when you prompt, typing when tools run, juggling subagents, reviewing permissions, celebrating when tasks complete, and sleeping when you're away.

## What This Fork Adds

### Auto-Hide on Sleep (Power Save)
When all agent sessions go idle, Clawd automatically hides after a configurable delay — no manual "DND" needed. The pet reappears instantly when any agent starts working again. Toggle via right-click menu "Auto Hide on Sleep". Useful for multi-monitor setups where a permanently-visible pet is distracting.

### AI Smart Notification Bubbles
Proactive floating notifications when your AI agents need attention:

- **Codex task done** — when a Codex session completes (Codex Desktop App or Cursor plugin), a bubble appears with "Go to Check" to jump back to the right window
- **Codex stuck** — if Codex has no activity for an extended period, a bubble warns you it may be waiting for input
- **Cursor awaiting user** — when Cursor Agent finishes and is waiting for your next prompt
- **Cursor tool stuck** — when a Cursor Agent tool call runs longer than expected

Each notification auto-expires and stacks with existing permission bubbles.

### Smart Focus for Codex-in-Cursor
When Codex runs as a Cursor plugin, clicking "Go to Check" on a notification now correctly jumps to Cursor instead of the standalone Codex App. The monitor reads the `originator` field from Codex session metadata to distinguish between the two.

### Codex Subagent Completion Suppression
Ported from upstream — when Codex spawns subagent sessions (e.g. guardian assessments), their completion no longer triggers false "happy" animations or "task done" notifications. Only the root session's completion matters.

### Opacity Slider
Adjust the pet's transparency via the Settings panel or right-click menu. Useful on small screens or when Clawd overlaps with content you need to read.

### Portrait Display Support
Clawd properly positions itself on portrait-oriented displays (vertical monitors), with correct clamping and edge detection.

## Upstream Features

All features from the original project are preserved:

- **Multi-agent support** — Claude Code, Codex CLI, Copilot CLI, Gemini CLI, Cursor Agent, Kiro CLI, and opencode
- **12 animated states** — idle, thinking, typing, building, juggling, conducting, error, happy, notification, sweeping, carrying, sleeping
- **Eye tracking, sleep sequence, click reactions, drag-and-drop, mini mode**
- **Permission bubbles** — in-app Allow/Deny for Claude Code and opencode
- **Session tracking** — multi-session priority, subagent awareness, terminal focus
- **Two built-in themes** — Clawd (pixel crab) and Calico (三花猫), with custom theme support
- **System tray, i18n (en/zh), auto-update, DND mode, sound effects**

Full upstream documentation: [original README](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/README.md)

## Quick Start

```bash
git clone https://github.com/aptx33/clawd-on-desk.git
cd clawd-on-desk
npm install
npm start
```

### Build macOS App

```bash
npm run build:mac    # DMG for both x64 and arm64
```

## Syncing with Upstream

This fork tracks upstream at `git@github.com:rullerzhou-afk/clawd-on-desk.git`. To pull in new upstream changes:

```bash
git fetch upstream
git merge upstream/main
# Resolve conflicts in: src/main.js, src/server.js, src/state.js, etc.
```

Key files modified by this fork (expect conflicts):
- `src/main.js` — auto-hide logic, smart notifications, Codex subagent classifier
- `src/server.js` — onServerStateReceived hook for auto-show
- `src/state.js` — originator field in session tracking
- `src/menu.js` — auto-hide menu item
- `src/permission.js` — autoShowIfNeeded integration
- `src/i18n.js` — notification translations
- `src/bubble.html` — agent notify bubble UI
- `agents/codex-log-monitor.js` — subagent classification, originator extraction, retired tracking

## License

Source code is licensed under the [MIT License](LICENSE).

**Artwork (assets/) is NOT covered by MIT.** All rights reserved by their respective copyright holders. See [assets/LICENSE](assets/LICENSE) for details.

- **Clawd** character is the property of [Anthropic](https://www.anthropic.com). This is an unofficial fan project, not affiliated with or endorsed by Anthropic.
- **Calico cat (三花猫)** artwork by 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)). All rights reserved.
