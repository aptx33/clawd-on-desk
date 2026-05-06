// Codex CLI JSONL log monitor
// Polls ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl for state changes
// Zero external dependencies (node built-ins + local Codex helpers only)
//
// Replay protection is two layers — change one, consider the other:
//   1. Line-level: _processLine skips entries whose `timestamp` field is
//      older than monitor start (minus 1.5s grace).
//   2. File-level: retired tracked files remember their offset so
//      re-tracking the same file doesn't replay already-seen lines.

const fs = require("fs");
const path = require("path");
const os = require("os");
const CodexSubagentClassifier = require("./codex-subagent-classifier");

const APPROVAL_HEURISTIC_MS = 2000;
const MAX_TRACKED_FILES = 50;
const MAX_RETIRED_TRACKED_FILES = 100;
const MAX_PARTIAL_BYTES = 65536;
const RECENT_DAY_DIR_CACHE_MS = 60 * 60 * 1000; // 1 hour
// 文件 mtime 早于 monitor 启动超过此阈值则视为历史会话，启用 backfill 模式
const BACKFILL_GRACE_MS = 5000;

class CodexLogMonitor {
  /**
   * @param {object} agentConfig - codex.js config (logConfig + logEventMap)
   * @param {function} onStateChange - (sessionId, state, event, extra) => void
   * @param {object} options
   */
  constructor(agentConfig, onStateChange, options = {}) {
    this._config = agentConfig;
    this._onStateChange = onStateChange;
    this._classifier = options.classifier || new CodexSubagentClassifier();
    this._interval = null;
    // Map<filePath, { offset, sessionId, cwd, lastEventTime, lastState, partial }>
    this._tracked = new Map();
    // 退役追踪：保留 offset/state 等元数据，避免重新追踪同一会话时重放旧事件
    this._retiredTracked = new Map();
    this._baseDir = this._resolveBaseDir();
    this._recentDayDirsCache = [];
    this._recentDayDirsCacheAt = 0;
    this._recentDayDirsDateKey = "";
    this._startedAtMs = Date.now();
  }

  _resolveBaseDir() {
    const dir = this._config.logConfig.sessionDir;
    if (dir.startsWith("~")) {
      return path.join(os.homedir(), dir.slice(1));
    }
    return dir;
  }

  start() {
    if (this._interval) return;
    this._startedAtMs = Date.now();
    // Initial scan
    this._poll();
    this._interval = setInterval(
      () => this._poll(),
      this._config.logConfig.pollIntervalMs || 1500
    );
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    for (const tracked of this._tracked.values()) {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
    }
    this._tracked.clear();
    this._retiredTracked.clear();
  }

  _poll() {
    const dirs = this._getSessionDirs();
    for (const dir of dirs) {
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue; // directory doesn't exist yet
      }
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
        const filePath = path.join(dir, file);
        // Skip files we're not already tracking if they haven't been written recently
        if (!this._tracked.has(filePath)) {
          try {
            const mtime = fs.statSync(filePath).mtimeMs;
            if (now - mtime > 120000) continue; // older than 2 min — completed session, skip
          } catch { continue; }
        }
        this._pollFile(filePath, file);
      }
    }
    this._pruneTrackedFilesIfNeeded();
  }

  _getSessionDirs() {
    const dirs = [];
    const seen = new Set();
    const addDir = (dir) => {
      if (!dir || seen.has(dir)) return;
      seen.add(dir);
      dirs.push(dir);
    };
    const now = new Date();
    for (let daysAgo = 0; daysAgo <= 2; daysAgo++) {
      const d = new Date(now);
      d.setDate(d.getDate() - daysAgo);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      addDir(path.join(this._baseDir, String(yyyy), mm, dd));
    }
    // Fallback: include most recent existing day dirs to handle
    // clock/timezone drift and `codex resume` of older sessions
    for (const dir of this._getCachedRecentExistingDayDirs(7)) addDir(dir);
    return dirs;
  }

  _getCachedRecentExistingDayDirs(limit = 7) {
    const now = Date.now();
    const dateKey = this._getLocalDateKey();
    const cacheStale = now - this._recentDayDirsCacheAt > RECENT_DAY_DIR_CACHE_MS;
    const dayChanged = dateKey !== this._recentDayDirsDateKey;
    if (!this._recentDayDirsCache.length || cacheStale || dayChanged) {
      this._recentDayDirsCache = this._getRecentExistingDayDirs(limit);
      this._recentDayDirsCacheAt = now;
      this._recentDayDirsDateKey = dateKey;
    }
    return this._recentDayDirsCache.slice(0, limit);
  }

  _getLocalDateKey() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  _getRecentExistingDayDirs(limit = 7) {
    const out = [];
    let years;
    try {
      years = fs.readdirSync(this._baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return out;
    }
    for (const y of years) {
      const yPath = path.join(this._baseDir, y);
      let months;
      try {
        months = fs.readdirSync(yPath, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
          .map((d) => d.name)
          .sort((a, b) => b.localeCompare(a));
      } catch { continue; }
      for (const m of months) {
        const mPath = path.join(yPath, m);
        let days;
        try {
          days = fs.readdirSync(mPath, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
            .map((d) => d.name)
            .sort((a, b) => b.localeCompare(a));
        } catch { continue; }
        for (const d of days) {
          out.push(path.join(mPath, d));
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  _pollFile(filePath, fileName) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    let tracked = this._tracked.get(filePath);
    if (!tracked) {
      // New file — extract session ID from filename
      // Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
      const sessionId = this._extractSessionId(fileName);
      if (!sessionId) return;
      // Cap tracked files to prevent unbounded Map growth
      if (this._tracked.size >= MAX_TRACKED_FILES) {
        this._pruneTrackedFilesIfNeeded();
        if (this._tracked.size >= MAX_TRACKED_FILES) return;
      }
      const retired = this._retiredTracked.get(filePath) || null;
      const resumeOffset = retired && stat.size >= retired.offset ? retired.offset : 0;
      if (retired) this._retiredTracked.delete(filePath);
      tracked = {
        offset: resumeOffset,
        sessionId: "codex:" + sessionId,
        filePath,
        cwd: retired ? retired.cwd : "",
        sessionTitle: retired ? retired.sessionTitle : null,
        lastEventTime: Date.now(),
        lastState: retired ? retired.lastState : null,
        lastStateEvent: retired ? retired.lastStateEvent : null,
        hasEmittedState: retired ? retired.hasEmittedState === true : false,
        partial: "",
        hadToolUse: retired ? retired.hadToolUse === true : false,
        isSubagent: retired ? retired.isSubagent === true : false,
        agentPid: retired ? retired.agentPid : null,
        pendingApprovalDetail: null,
        // Backfill 模式：文件 mtime 早于 monitor 启动（减去 BACKFILL_GRACE_MS）
        // 视为历史会话，静默消费但不触发状态变更。
        // 空文件无需 replay；grace window 内的视为活跃会话正常发射。
        backfilling:
          !retired &&
          stat.size > 0 &&
          stat.mtimeMs < this._startedAtMs - BACKFILL_GRACE_MS,
      };
      this._tracked.set(filePath, tracked);
    }

    // No new data
    if (stat.size <= tracked.offset) return;

    // Read incremental bytes
    let buf;
    try {
      const fd = fs.openSync(filePath, "r");
      const readLen = stat.size - tracked.offset;
      buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, tracked.offset);
      fs.closeSync(fd);
    } catch {
      return;
    }
    tracked.offset = stat.size;

    // Split into lines, handle partial last line
    const text = tracked.partial + buf.toString("utf8");
    const lines = text.split("\n");
    // Last element might be incomplete — save for next poll.
    // Cap at 64KB: lines larger than this (e.g. huge tool output) are discarded —
    // both halves will fail JSON.parse so one state update is silently lost, which
    // is harmless for the pet's display state.
    const remainder = lines.pop() || "";
    tracked.partial = remainder.length > MAX_PARTIAL_BYTES ? "" : remainder;

    for (const line of lines) {
      if (!line.trim()) continue;
      this._processLine(line, tracked);
    }
  }

  _processLine(line, tracked) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // corrupted line, skip
    }

    // Skip historical events that predate monitor start — prevents replay
    // storms on app restart from driving stale state transitions
    if (obj && typeof obj.timestamp === "string") {
      const ts = Date.parse(obj.timestamp);
      if (Number.isFinite(ts) && ts < this._startedAtMs - 1500) return;
    }

    const type = obj.type;
    const payload = obj.payload;
    const subtype =
      payload && typeof payload === "object" ? payload.type || "" : "";

    // Build lookup key
    const key = subtype ? type + ":" + subtype : type;

    // Extract CWD and originator from session_meta
    if (type === "session_meta" && payload) {
      tracked.cwd = payload.cwd || "";
      if (payload.originator) tracked.originator = payload.originator;
      // 通过 session_meta 的 source 字段判断 subagent 角色
      const role = this._classifier.registerSession(tracked.sessionId, { sessionMeta: payload });
      if (role === "subagent") tracked.isSubagent = true;
      else if (role === "root") tracked.isSubagent = false;
    }

    // Approval heuristic: exec_command_end or function_call_output means command finished —
    // clear pending approval timer (these events are not in logEventMap)
    if (key === "event_msg:exec_command_end" || key === "response_item:function_call_output") {
      if (tracked.approvalTimer) {
        clearTimeout(tracked.approvalTimer);
        tracked.approvalTimer = null;
      }
    }

    // Look up state mapping
    const map = this._config.logEventMap;
    const state = map[key];
    if (state === undefined) return; // unmapped event, skip
    if (state === null) return; // explicitly ignored

    // Track tool use per turn — reset on task_started, set on function_call
    if (key === "event_msg:task_started") {
      tracked.hadToolUse = false;
    }
    if (key === "response_item:function_call") {
      tracked.hadToolUse = true;
    }

    // Turn-end: happy if tools were used this turn, idle otherwise
    // Subagent 的 turn-end 始终映射为 idle，避免子任务完成闪 happy 动画
    if (state === "codex-turn-end") {
      if (tracked.approvalTimer) {
        clearTimeout(tracked.approvalTimer);
        tracked.approvalTimer = null;
      }
      tracked.pendingApprovalDetail = null;
      const resolved = this._isTrackedSubagent(tracked)
        ? "idle"
        : (tracked.hadToolUse ? "attention" : "idle");
      tracked.hadToolUse = false;
      tracked.lastState = resolved;
      if (tracked.backfilling) return;
      tracked.hasEmittedState = true;
      tracked.lastEventTime = Date.now();
      this._emitStateChange(tracked, resolved, key);
      return;
    }

    // Approval heuristic: function_call starts a 2s timer — if no exec_command_end arrives,
    // assume Codex is waiting for user approval and emit codex-permission.
    // Explicit escalated requests (sandbox_permissions/justification) skip the timer.
    if (key === "response_item:function_call") {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
      const cmd = this._extractShellCommand(payload);
      if (cmd) {
        if (this._isExplicitApprovalRequest(payload)) {
          const agentPid = this._resolveTrackedAgentPid(tracked);
          tracked.lastEventTime = Date.now();
          this._onStateChange(tracked.sessionId, "codex-permission", key, {
            cwd: tracked.cwd,
            sourcePid: agentPid,
            agentPid,
            permissionDetail: { command: cmd, rawPayload: payload },
          });
          return;
        }
        tracked.approvalTimer = setTimeout(() => {
          tracked.approvalTimer = null;
          const agentPid = this._resolveTrackedAgentPid(tracked);
          tracked.lastEventTime = Date.now();
          this._onStateChange(tracked.sessionId, "codex-permission", key, {
            cwd: tracked.cwd,
            sourcePid: agentPid,
            agentPid,
            permissionDetail: { command: cmd, rawPayload: payload },
          });
        }, APPROVAL_HEURISTIC_MS);
      }
    }

    // Avoid spamming same state
    if (state === tracked.lastState && state === "working") return;
    tracked.lastState = state;
    tracked.lastEventTime = Date.now();
    if (tracked.backfilling) return;
    tracked.hasEmittedState = true;
    this._emitStateChange(tracked, state, key);
  }

  // Extract shell command from function_call payload
  // shell_command: {"command":"...","workdir":"..."}
  // exec_command:  {"cmd":"...","workdir":"..."}
  _extractShellCommand(payload) {
    if (!payload || typeof payload !== "object") return "";
    if (payload.name !== "shell_command" && payload.name !== "exec_command") return "";
    try {
      const args = typeof payload.arguments === "string"
        ? JSON.parse(payload.arguments) : payload.arguments;
      if (args && args.command) return String(args.command);
      if (args && args.cmd) return String(args.cmd);
    } catch {}
    return "";
  }

  _isExplicitApprovalRequest(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.name !== "shell_command" && payload.name !== "exec_command") return false;
    try {
      const args = typeof payload.arguments === "string"
        ? JSON.parse(payload.arguments) : payload.arguments;
      if (!args || typeof args !== "object") return false;
      if (args.sandbox_permissions === "require_escalated") return true;
      if (typeof args.justification === "string" && args.justification.trim()) return true;
    } catch {}
    return false;
  }

  // Extract UUID from rollout filename
  // rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl
  _extractSessionId(fileName) {
    // UUID v7 is the last 5 segments of the filename (before .jsonl)
    const base = fileName.replace(".jsonl", "");
    const parts = base.split("-");
    // UUID: last 5 parts (8-4-4-4-12 hex)
    if (parts.length < 10) return null;
    return parts.slice(-5).join("-");
  }

  _resolveTrackedAgentPid(tracked) {
    if (tracked.agentPid && this._isProcessAlive(tracked.agentPid)) {
      return tracked.agentPid;
    }
    const pid = this._findCodexWriterPid(tracked.filePath);
    tracked.agentPid = pid || null;
    return tracked.agentPid;
  }

  _isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err && err.code === "EPERM";
    }
  }

  // Linux-only: find codex process that has the rollout file open via /proc
  _findCodexWriterPid(filePath) {
    if (process.platform !== "linux" || !filePath) return null;
    let procEntries;
    try {
      procEntries = fs.readdirSync("/proc", { withFileTypes: true });
    } catch {
      return null;
    }
    for (const ent of procEntries) {
      if (!ent.isDirectory() || !/^\d+$/.test(ent.name)) continue;
      const pid = Number(ent.name);
      if (!Number.isFinite(pid) || pid <= 1) continue;
      // Fast prefilter: skip non-codex processes
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!cmd.includes("codex")) continue;
      } catch { continue; }
      let fds;
      try {
        fds = fs.readdirSync(`/proc/${pid}/fd`);
      } catch { continue; }
      for (const fd of fds) {
        try {
          const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (target === filePath) return pid;
        } catch {}
      }
    }
    return null;
  }

  _isTrackedSubagent(tracked) {
    if (!tracked) return false;
    const role = this._classifier && typeof this._classifier.classify === "function"
      ? this._classifier.classify(tracked.sessionId)
      : "unknown";
    if (role === "subagent") {
      tracked.isSubagent = true;
      return true;
    }
    if (role === "root") {
      tracked.isSubagent = false;
      return false;
    }
    return tracked.isSubagent === true;
  }

  _emitStateChange(tracked, state, event, extra = null) {
    tracked.lastState = state;
    tracked.lastEventTime = Date.now();
    const agentPid = this._resolveTrackedAgentPid(tracked);
    this._onStateChange(tracked.sessionId, state, event, {
      cwd: tracked.cwd,
      sourcePid: typeof agentPid === "number" && Number.isFinite(agentPid)
        ? agentPid
        : agentPid,
      agentPid,
      sessionTitle: tracked.sessionTitle,
      originator: tracked.originator,
      ...(extra || {}),
      headless: this._isTrackedSubagent(tracked)
        ? true
        : (extra && Object.prototype.hasOwnProperty.call(extra, "headless") ? extra.headless : undefined),
    });
  }

  // 按年龄淘汰追踪文件，优先淘汰从未发射过状态的文件
  _pruneTrackedFilesIfNeeded() {
    if (this._tracked.size < MAX_TRACKED_FILES) return;
    const byAge = (a, b) => (a[1].lastEventTime || 0) - (b[1].lastEventTime || 0);
    const neverEmitted = [...this._tracked.entries()]
      .filter(([, tracked]) => tracked && !tracked.hasEmittedState)
      .sort(byAge);
    const emitted = [...this._tracked.entries()]
      .filter(([, tracked]) => tracked && tracked.hasEmittedState)
      .sort(byAge);
    for (const [filePath, tracked] of [...neverEmitted, ...emitted]) {
      if (this._tracked.size < MAX_TRACKED_FILES) break;
      this._retireTrackedFile(filePath, tracked);
    }
  }

  _retireTrackedFile(filePath, tracked) {
    if (tracked && tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
    this._tracked.delete(filePath);
    if (!filePath || !tracked) return;
    this._retiredTracked.delete(filePath);
    this._retiredTracked.set(filePath, {
      offset: Number.isFinite(tracked.offset) ? tracked.offset : 0,
      cwd: tracked.cwd || "",
      sessionTitle: tracked.sessionTitle || null,
      lastState: tracked.lastState || null,
      lastStateEvent: tracked.lastStateEvent || null,
      hasEmittedState: tracked.hasEmittedState === true,
      hadToolUse: tracked.hadToolUse === true,
      isSubagent: tracked.isSubagent === true,
      agentPid: tracked.agentPid || null,
      originator: tracked.originator || null,
    });
    while (this._retiredTracked.size > MAX_RETIRED_TRACKED_FILES) {
      const oldest = this._retiredTracked.keys().next().value;
      this._retiredTracked.delete(oldest);
    }
  }
}

module.exports = CodexLogMonitor;
