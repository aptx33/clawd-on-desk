# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Clawd 桌宠 — 一个 Electron 桌面宠物，通过 Claude Code hook 系统实时感知工作状态并播放对应的像素风 SVG 动画。仅支持 Windows 11。

## 常用命令

```bash
npm start              # 启动 Electron 应用（开发模式）
npm run build          # electron-builder 打包 Windows NSIS 安装包
npm install            # 安装依赖（electron + electron-builder）
node hooks/install.js  # 注册 Claude Code hooks 到 ~/.claude/settings.json
bash test-demo.sh [秒] # 逐个播放所有 SVG 动画（默认每个 8 秒）
bash test-mini.sh [秒] # 逐个播放极简模式 SVG 动画（默认每个 6 秒）
```

手动测试状态切换：
```bash
curl -X POST http://127.0.0.1:23333/state \
  -H "Content-Type: application/json" \
  -d '{"state":"working","svg":"clawd-working-building.svg"}'
```

当前无测试框架，`npm test` 为占位符。

## 架构与数据流

```
Claude Code 触发事件
  → hooks/clawd-hook.js（零依赖 Node 脚本，stdin 读 JSON 取 session_id）
  → HTTP POST 127.0.0.1:23333/state { state, session_id, svg?, event? }
  → src/main.js 状态机（多会话追踪 + 优先级 + 最小显示时长 + 睡眠序列）
  → IPC state-change 事件
  → src/renderer.js（<object> SVG 预加载 + 淡入切换 + 眼球追踪）
```

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/main.js` | Electron 主进程：窗口管理、HTTP 服务、状态机、系统托盘、光标轮询、眼球位置计算 |
| `src/renderer.js` | 渲染进程：拖拽（delta-based + RAF 节流）、SVG 切换（预加载防闪烁）、眼球 DOM 挂接、点击反应 |
| `src/preload.js` | contextBridge 暴露 IPC API（moveWindowBy、onStateChange、onEyeMove、showContextMenu、onMiniModeChange、exitMiniMode、dragEnd） |
| `hooks/clawd-hook.js` | Claude Code hook 脚本：事件名 → 状态映射 → HTTP POST，零依赖，800ms 超时不阻塞 |
| `hooks/install.js` | 安全注册 hooks 到 settings.json，逐事件追加不覆盖 |

### 状态机关键机制（均在 main.js）

- **多会话追踪**：`sessions` Map 按 session_id 独立记录状态，`resolveDisplayState()` 取最高优先级
- **状态优先级**：error(8) > notification(7) > sweeping(6) > attention(5) > carrying/juggling(4) > working(3) > thinking(2) > idle(1) > sleeping(0)
- **最小显示时长**：防止快速闪切（error 5s、attention/notification 4s、carrying 3s、sweeping 2s、working/thinking 1s）
- **单次性状态**：attention/error/sweeping/notification/carrying 显示后自动回退（AUTO_RETURN_MS）
- **睡眠序列**：20s 鼠标静止 → idle-look → 60s → yawning(3.8s) → dozing → 10min → collapsing(0.8s) → sleeping
- **working 子动画**：1 个会话 → typing，2 个 → juggling，3+ → building
- **juggling 子动画**：1 个 subagent → juggling，2+ → conducting

### 眼球追踪系统（main.js 计算 → renderer.js 渲染）

- main.js 每 67ms（~15fps）轮询光标位置，计算眼球偏移量（MAX_OFFSET=3px，量化到 0.5px 像素网格）
- 通过 IPC `eye-move` 发送 `{dx, dy}` 到 renderer
- renderer 操作 SVG 内部 DOM：`#eyes-js` translate + `#body-js` 轻微偏移 + `#shadow-js` 拉伸
- **dedup 优化**：鼠标未移动时跳过发送；但从 idle-look 返回 idle-follow 时需要 `forceEyeResend` 旁路，否则眼球位置不会重新同步

### 点击反应系统（renderer.js）

- 双击 → 戳反应（左/右方向检测，2.5s）
- 4 连击 → 东张西望反应（3.5s）
- 拖拽 → 拖拽反应（持续到松手）
- 拖拽判定：鼠标位移 > 3px（DRAG_THRESHOLD），否则视为点击
- 反应期间 detach 眼球追踪，结束后 reattach

### 极简模式（Mini Mode）

角色藏在屏幕右边缘，窗口一半推到屏幕外，屏幕边缘自然遮住另一半身体。

**进入方式**：
- 拖拽到右边缘（SNAP_TOLERANCE=30px）→ 快速滑入 + mini-enter 动画
- 右键菜单"Mini Mode" → 螃蟹步走到边缘 → 抛物线跳入 → 探头入场

**核心机制**（均在 main.js）：
- `miniMode` 顶层标志，`applyState()` 拦截 notification → mini-alert, attention → mini-happy，其他状态静默
- `miniTransitioning` 过渡保护，螃蟹步/入场期间屏蔽 hook 事件和 peek
- `checkMiniModeSnap()` 遍历所有显示器右边缘 + 中心点 XY 范围检查
- Peek hover：`startMainTick()` 检测 `mouseOverPet` + `currentState === "mini-peek"` 控制滑出/滑回
- `miniIdleNow` 独立于 `idleNow`，仅走眼球追踪，跳过 idle-look/sleep 序列
- 窗口动画：`animateWindowX()`（滑动）+ `animateWindowParabola()`（抛物线跳跃，用 `setPosition()` 避免 DPI 漂移）
- 入场过渡：跳到所有屏幕最右端 → 屏幕外加载 enter SVG → 300ms 后移到 mini 位置
- 退出：清 autoReturnTimer/pendingTimer + `applyState()` 直接切换（绕过 MIN_DISPLAY_MS）
- 持久化：`savePrefs()` 存 miniMode/preMiniX/preMiniY，启动时恢复 + Y 轴 clamp

**Mini 状态 → SVG 映射**：
| 状态 | SVG | 用途 |
|------|-----|------|
| mini-idle | clawd-mini-idle.svg | 待机：呼吸+眨眼+手臂晃动+眼球追踪 |
| mini-enter | clawd-mini-enter.svg | 入场：一次性滑入弹跳→手臂伸出→静止 |
| mini-peek | clawd-mini-peek.svg | Hover 探头：快速招手 3 下 |
| mini-alert | clawd-mini-alert.svg | 通知：感叹号弹出 + >< 挤眼 |
| mini-happy | clawd-mini-happy.svg | 完成：花花 + ^^ 眯眼 + 星星 |
| mini-crabwalk | clawd-mini-crabwalk.svg | 右键进入时的螃蟹步 |

## 状态 → 动画映射

| Claude Code 事件 | 桌宠状态 | 动画 SVG |
|------------------|---------|----------|
| 无活动 | idle | clawd-idle-follow.svg（眼球追踪） |
| 20s 鼠标静止 | idle | clawd-idle-look.svg（四处张望） |
| UserPromptSubmit | thinking | clawd-working-thinking.svg |
| PreToolUse / PostToolUse（1 会话） | working | clawd-working-typing.svg |
| PreToolUse / PostToolUse（3+ 会话） | working | clawd-working-building.svg |
| SubagentStart（1 个） | juggling | clawd-working-juggling.svg |
| SubagentStart（2+） | juggling | clawd-working-conducting.svg |
| Stop / PostCompact | attention | clawd-happy.svg |
| PostToolUseFailure | error | clawd-error.svg |
| Notification / PermissionRequest | notification | clawd-notification.svg |
| PreCompact | sweeping | clawd-working-sweeping.svg |
| WorktreeCreate | carrying | clawd-working-carrying.svg |
| 60s 无事件 | sleeping | clawd-sleeping.svg（经 yawning → dozing → collapsing 序列） |

## 关键 Electron 配置

- `win.setFocusable(false)` — 永不抢焦点
- `win.showInactive()` — 显示时不打断用户输入
- 资源路径始终用 `path.join(__dirname, ...)` — 确保打包后不丢文件
- 透明无边框浮窗：`frame: false`, `transparent: true`, `alwaysOnTop: true`
- 单实例锁：`app.requestSingleInstanceLock()` 防止重复启动
- 位置持久化：窗口坐标 + 尺寸存入 `%LOCALAPPDATA%/Clawd on Desk/clawd-prefs.json`
- 多显示器边界钳制：`clampToScreen()` 用 `getNearestWorkArea()` 查找最近显示器工作区
- 极简模式持久化：`clawd-prefs.json` 存储 miniMode + preMiniX/preMiniY，重启自动恢复

## 素材规则

- `clawd-tank/` 是第三方参考仓库（MIT），**禁止修改**
- 项目使用的 SVG 在 `assets/svg/`（35 个，含 6 个 mini mode），GIF 在 `assets/gif/`（18 个，文档展示用）
- 需要编辑的素材复制到 `assets/source/` 再修改
- SVG 用 `<object type="image/svg+xml">` 渲染——因为需要访问 SVG 内部 DOM（眼球追踪），`<img>` 无法做到
- SVG 内部约定 ID：`#eyes-js`（眼球）、`#body-js`（身体）、`#shadow-js`（影子）供 JS 操作
- GIF 通过 `scripts/record-gifs.js`（Electron + ffmpeg）自动录制，mini 模式用 `scripts/record-mini-gifs.js`（viewBox 替换 + 墙遮罩）

## 开发规范

- 敏感信息只放 `.env`，禁止硬编码
- 注册 Claude Code hook 时必须**追加**到已有 hook 数组，不能覆盖
- HTTP 服务端口固定 `127.0.0.1:23333`，端口占用时降级为 idle-only 模式
- hook 脚本必须保持零依赖（仅 node 内置模块），确保任何环境可运行

## 已知限制

- 如果桌宠在 Claude Code 会话中途启动，会保持 idle 直到下一个 hook 事件触发
- hook 脚本依赖 Node.js 可用
