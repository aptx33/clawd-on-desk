<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd 桌宠 (增强 Fork)</h1>
<p align="center">
  <a href="README.md">English</a> · <a href="https://github.com/rullerzhou-afk/clawd-on-desk">上游仓库</a>
</p>

> 这是 [@rullerzhou-afk](https://github.com/rullerzhou-afk) 的 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) 的**个人 Fork**。在上游功能的基础上增加了一些实用增强。

一个能实时感知 AI 编程助手工作状态的桌面宠物。Clawd 住在你的屏幕上——你提问时它思考，工具运行时它打字，子代理工作时它杂耍，审批权限时它弹卡片，任务完成时它庆祝，你离开时它睡觉。

## 本 Fork 新增功能

### 空闲自动隐藏（省电模式）
当所有 Agent 会话进入空闲状态，Clawd 在可配置的延迟后自动隐藏——无需手动开"免打扰"。任何 Agent 开始工作时桌宠立即重新出现。通过右键菜单"空闲时自动隐藏"开关。适合多屏幕场景，避免桌宠长期占据视线。

### AI 智能通知气泡
主动浮动通知，当 AI Agent 需要你注意时弹出：

- **Codex 任务完成** — Codex 会话完成时弹出气泡，点击"去查看"跳转到正确的窗口
- **Codex 可能卡住** — Codex 长时间无新活动时发出提醒
- **Cursor 等待用户** — Cursor Agent 完成后等待你的下一条指令
- **Cursor 工具卡住** — Cursor Agent 的工具调用耗时超预期时提醒

每条通知都有自动过期机制，与权限气泡共享堆叠布局。

### Codex-in-Cursor 智能跳转
当 Codex 作为 Cursor 插件运行时，点击通知气泡的"去查看"会正确跳转到 Cursor 而不是 Codex App。通过读取 Codex 会话的 `originator` 字段来区分两种运行环境。

### Codex Subagent 完成抑制
移植自上游——当 Codex 产生子会话（如 guardian 评估）时，子会话的完成不再误触发 happy 动画或"任务完成"通知。只有根会话的完成才会展示。

### 透明度调节
通过设置面板或右键菜单调节桌宠透明度。小屏幕或内容被桌宠遮挡时很有用。

### 竖屏显示器支持
Clawd 在竖屏（Portrait）显示器上能正确定位，边缘检测和位置钳制均已适配。

## 上游功能

上游项目的所有功能均已保留：

- **多 Agent 支持** — Claude Code、Codex CLI、Copilot CLI、Gemini CLI、Cursor Agent、Kiro CLI、opencode
- **12 种动画状态** — 待机、思考、打字、建造、杂耍、指挥、报错、开心、通知、扫地、搬运、睡觉
- **眼球追踪、睡眠序列、点击反应、拖拽、极简模式**
- **权限气泡** — Claude Code 和 opencode 的桌面端 Allow/Deny
- **会话追踪** — 多会话优先级、子代理感知、终端聚焦
- **两套内置主题** — Clawd（像素螃蟹）和 Calico（三花猫），支持自定义主题
- **系统托盘、国际化（中/英）、自动更新、免打扰模式、提示音效**

上游完整文档：[原项目 README](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/README.zh-CN.md)

## 快速开始

```bash
git clone https://github.com/aptx33/clawd-on-desk.git
cd clawd-on-desk
npm install
npm start
```

### 打包 macOS App

```bash
npm run build:mac    # 同时生成 x64 和 arm64 的 DMG
```

## 同步上游更新

本 fork 追踪上游仓库 `git@github.com:rullerzhou-afk/clawd-on-desk.git`。拉取上游新改动：

```bash
git fetch upstream
git merge upstream/main
# 解决冲突文件：src/main.js, src/server.js, src/state.js 等
```

本 fork 修改的关键文件（合并时可能冲突）：
- `src/main.js` — 自动隐藏逻辑、智能通知、Codex subagent 分类器
- `src/server.js` — onServerStateReceived 钩子用于自动显示
- `src/state.js` — session 中的 originator 字段
- `src/menu.js` — 自动隐藏菜单项
- `src/permission.js` — autoShowIfNeeded 集成
- `src/i18n.js` — 通知文案翻译
- `src/bubble.html` — agent 通知气泡 UI
- `agents/codex-log-monitor.js` — subagent 分类、originator 提取、退役追踪

## 许可证

源代码基于 [MIT 许可证](LICENSE) 开源。

**美术素材（assets/）不适用 MIT 许可。** 所有权利归各自版权持有人所有，详见 [assets/LICENSE](assets/LICENSE)。

- **Clawd** 角色设计归属 [Anthropic](https://www.anthropic.com)。本项目为非官方粉丝作品，与 Anthropic 无官方关联。
- **三花猫** 素材由 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) 创作，保留所有权利。
