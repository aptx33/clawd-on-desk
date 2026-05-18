"use strict";

// src/quota.js — AI quota data layer (CPA + Cursor)
// [quota] Independent module — no coupling to Clawd core.
//
// Polls CPA management API and Cursor local auth for usage data.
// Exposes getQuotaData(), refresh(), start(), stop() for consumers.

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { execFile } = require("child_process");

const isMac = process.platform === "darwin";

// ── Cursor token from local SQLite ──

const CURSOR_DB_PATH = isMac
  ? path.join(process.env.HOME || "", "Library/Application Support/Cursor/User/globalStorage/state.vscdb")
  : path.join(process.env.APPDATA || process.env.HOME || "", ".config/Cursor/User/globalStorage/state.vscdb");

function readCursorToken() {
  return new Promise((resolve) => {
    if (!fs.existsSync(CURSOR_DB_PATH)) {
      resolve(null);
      return;
    }
    execFile("sqlite3", [CURSOR_DB_PATH, "SELECT value FROM itemTable WHERE key='cursorAuth/accessToken'"], {
      timeout: 3000,
    }, (err, stdout) => {
      if (err || !stdout || !stdout.trim()) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function readCursorRefreshToken() {
  return new Promise((resolve) => {
    if (!fs.existsSync(CURSOR_DB_PATH)) {
      resolve(null);
      return;
    }
    execFile("sqlite3", [CURSOR_DB_PATH, "SELECT value FROM itemTable WHERE key='cursorAuth/refreshToken'"], {
      timeout: 3000,
    }, (err, stdout) => {
      if (err || !stdout || !stdout.trim()) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// ── HTTP helpers ──

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers, timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch { resolve(body); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const parsed = new URL(url);
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      timeout: 15000,
    }, (res) => {
      let buf = "";
      res.on("data", (chunk) => { buf += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

// ── Cursor usage fetch ──

async function fetchCursorUsage(accessToken, clientId) {
  try {
    const data = await httpGet("https://api2.cursor.sh/auth/usage", {
      Authorization: `Bearer ${accessToken}`,
    });
    return data;
  } catch (err) {
    // token 可能过期，尝试 refresh
    if (!clientId) throw err;
    const refreshToken = await readCursorRefreshToken();
    if (!refreshToken) throw err;

    try {
      const tokenData = await httpPost("https://api2.cursor.sh/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      });
      if (tokenData && tokenData.access_token) {
        return await httpGet("https://api2.cursor.sh/auth/usage", {
          Authorization: `Bearer ${tokenData.access_token}`,
        });
      }
    } catch {}
    throw err;
  }
}

// ── CPA quota fetch ──

const CPA_BASE = "http://127.0.0.1:8317/v0/management";

async function fetchCpaAuthFiles(managementKey) {
  return await httpGet(`${CPA_BASE}/auth-files`, {
    "X-Management-Key": managementKey,
  });
}

// 通过 CPA api-call 代理向上游获取 Codex 额度
async function fetchCodexQuotaViaProxy(managementKey, authIndex, accountId) {
  const header = {
    "Authorization": "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal",
  };
  if (accountId) header["Chatgpt-Account-Id"] = accountId;

  let resp;
  try {
    resp = await httpPost(`${CPA_BASE}/api-call`, {
      authIndex,
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage",
      header,
    }, { "X-Management-Key": managementKey });
  } catch (err) {
    console.warn("[quota] Codex api-call network error:", err.message);
    return null;
  }

  if (resp && resp.status_code >= 200 && resp.status_code < 300 && resp.body) {
    return typeof resp.body === "string" ? JSON.parse(resp.body) : resp.body;
  }
  if (resp && resp.error) {
    console.warn("[quota] Codex api-call error:", resp.error);
  }
  return null;
}

// 通过 CPA api-call 代理向上游获取 Antigravity 额度
async function fetchAntigravityQuotaViaProxy(managementKey, authIndex) {
  const resp = await httpPost(`${CPA_BASE}/api-call`, {
    authIndex,
    method: "POST",
    url: "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    header: {
      "Authorization": "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": "antigravity/1.11.5 windows/amd64",
    },
    data: '{"project":""}',
  }, { "X-Management-Key": managementKey });

  if (resp && resp.status_code >= 200 && resp.status_code < 300 && resp.body) {
    return typeof resp.body === "string" ? JSON.parse(resp.body) : resp.body;
  }
  return null;
}

// 通过 CPA api-call 代理向上游获取 Gemini CLI 额度
async function fetchGeminiCliQuotaViaProxy(managementKey, authIndex, project) {
  const resp = await httpPost(`${CPA_BASE}/api-call`, {
    authIndex,
    method: "POST",
    url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    header: {
      "Authorization": "Bearer $TOKEN$",
      "Content-Type": "application/json",
    },
    data: JSON.stringify({ project: project || "" }),
  }, { "X-Management-Key": managementKey });

  if (resp && resp.status_code >= 200 && resp.status_code < 300 && resp.body) {
    return typeof resp.body === "string" ? JSON.parse(resp.body) : resp.body;
  }
  return null;
}

// Antigravity 白名单：前缀匹配 + 精确匹配
const AG_PREFIX_WHITELIST = ["claude-", "gpt-", "gemini-3.1-pro-"];
const AG_EXACT_WHITELIST = new Set([
  "gemini-2.5-flash",
  "gemini-3-flash", "gemini-pro-agent", "gemini-3-flash-agent",
]);

// Antigravity 分组：Claude / GPT / Gemini 各自独立展示
const AG_GROUP_DEFINITIONS = [
  { label: "Claude", matcher: (id) => id.startsWith("claude-") },
  { label: "GPT", matcher: (id) => id.startsWith("gpt-") },
  { label: "Gemini 3.1 Pro Series", matcher: (id) => id === "gemini-pro-agent" || id === "gemini-3.1-pro-high" || id === "gemini-3.1-pro-low" },
  { label: "Gemini 2.5 Flash", matcher: (id) => id === "gemini-2.5-flash" || id === "gemini-2.5-flash-thinking" },
  { label: "Gemini 3 Flash", matcher: (id) => id === "gemini-3-flash" || id === "gemini-3-flash-agent" },
];

function _isAgVisible(id) {
  return AG_PREFIX_WHITELIST.some((p) => id.startsWith(p)) || AG_EXACT_WHITELIST.has(id);
}

// Antigravity 凭证报额度耗尽时，Claude/GPT 分组必须按 0% 展示，不能继续信任模型列表接口的 100%
function _isAgQuotaExhausted(status, statusMessage) {
  const text = `${status || ""}\n${statusMessage || ""}`;
  return /RESOURCE_EXHAUSTED|resource has been exhausted|quota|额度/i.test(text);
}

// Antigravity 分组额度按“最差剩余额度 + 最早重置时间”聚合，避免把任一子模型的耗尽状态冲淡
function _buildAntigravityGroups(models, status, statusMessage) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const exhausted = _isAgQuotaExhausted(status, statusMessage);
  const groups = [];

  for (const def of AG_GROUP_DEFINITIONS) {
    const matched = models.filter((model) => def.matcher(model.modelId));
    if (matched.length === 0) continue;

    let remainingFraction = null;
    let resetTime = null;
    for (const model of matched) {
      if (typeof model.remainingFraction === "number") {
        remainingFraction = remainingFraction == null ? model.remainingFraction : Math.min(remainingFraction, model.remainingFraction);
      }
      if (model.resetTime && model.resetTime !== "1970-01-01T00:00:00Z") {
        resetTime = !resetTime || new Date(model.resetTime) < new Date(resetTime) ? model.resetTime : resetTime;
      }
    }

    // Claude / GPT 实测不可用时，管理态比模型目录接口更可信
    if ((def.label === "Claude" || def.label === "GPT") && exhausted) {
      remainingFraction = 0;
      resetTime = null;
    }

    groups.push({
      label: def.label,
      remainingFraction,
      resetTime,
      modelIds: matched.map((model) => model.modelId),
    });
  }

  return groups;
}

function _flattenModels(modelsMap) {
  if (!modelsMap) return [];
  return Object.entries(modelsMap)
    .filter(([id]) => _isAgVisible(id))
    .map(([id, info]) => {
      const qi = info?.quotaInfo || {};
      return {
        modelId: id,
        // API 不返回 remainingFraction 时视为额度已耗尽
        remainingFraction: typeof qi.remainingFraction === "number" ? qi.remainingFraction : 0,
        resetTime: qi.resetTime || null,
      };
    }).sort((a, b) => a.modelId.localeCompare(b.modelId));
}

// Gemini CLI 白名单（使用 API 返回的实际 modelId）
const GEMINI_WHITELIST = new Set([
  "gemini-2.5-flash-lite",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
]);

// 从 retrieveUserQuota 的 buckets 中提取模型列表
function _flattenBuckets(buckets) {
  if (!buckets) return [];
  return buckets
    .filter((b) => GEMINI_WHITELIST.has(b.modelId))
    .map((b) => ({
      modelId: b.modelId,
      remainingFraction: b.remainingFraction ?? null,
      resetTime: b.resetTime || null,
    })).sort((a, b) => a.modelId.localeCompare(b.modelId));
}

// 从 account 字段提取 project（格式 "email (project)"）
function _extractProject(account) {
  if (!account) return "";
  const m = account.match(/\(([^)]+)\)/);
  return m ? m[1] : "";
}

async function fetchFullCpaData(managementKey) {
  const authData = await fetchCpaAuthFiles(managementKey);
  const files = authData?.files || [];
  const codexFiles = files.filter((f) => f.provider === "codex");
  const antigravityFiles = files.filter((f) => f.provider === "antigravity");
  const geminiFiles = files.filter((f) => f.provider === "gemini-cli");

  // 并发获取所有凭证的额度
  const codexResults = await Promise.all(codexFiles.map(async (f) => {
    const base = {
      name: f.label || f.account || f.name,
      plan: f.id_token?.plan_type || "",
      status: f.status || "unknown",
      unavailable: !!f.unavailable,
      success: f.success || 0,
      failed: f.failed || 0,
    };
    try {
      const accountId = f.id_token?.chatgpt_account_id;
      const quota = await fetchCodexQuotaViaProxy(managementKey, f.auth_index, accountId);
      if (quota) {
        const rl = quota.rate_limit || {};
        const pw = rl.primary_window;
        const sw = rl.secondary_window;
        base.plan = quota.plan_type || base.plan;
        if (pw) {
          base.fiveHourUsedPct = pw.used_percent ?? null;
          base.fiveHourResetSec = pw.reset_after_seconds ?? null;
        }
        if (sw) {
          base.weeklyUsedPct = sw.used_percent ?? null;
          base.weeklyResetSec = sw.reset_after_seconds ?? null;
        }
        base.limitReached = rl.limit_reached || false;
      }
    } catch (err) {
      console.warn("[quota] Codex proxy fetch failed:", f.name, err.message);
    }
    return base;
  }));

  const antigravityResults = await Promise.all(antigravityFiles.map(async (f) => {
    const base = {
      name: f.label || f.account || f.name,
      status: f.status || "unknown",
      statusMessage: f.status_message || "",
      unavailable: !!f.unavailable,
      success: f.success || 0,
      failed: f.failed || 0,
      models: [],
      groups: [],
    };
    try {
      const data = await fetchAntigravityQuotaViaProxy(managementKey, f.auth_index);
      if (data && data.models) {
        base.models = _flattenModels(data.models);
        base.groups = _buildAntigravityGroups(base.models, base.status, base.statusMessage);
      }
    } catch (err) {
      console.warn("[quota] Antigravity proxy fetch failed:", f.name, err.message);
    }
    return base;
  }));

  const geminiResults = await Promise.all(geminiFiles.map(async (f) => {
    const project = _extractProject(f.account);
    const base = {
      name: f.label || f.account || f.name,
      project,
      status: f.status || "unknown",
      unavailable: !!f.unavailable,
      success: f.success || 0,
      failed: f.failed || 0,
      models: [],
    };
    try {
      const data = await fetchGeminiCliQuotaViaProxy(managementKey, f.auth_index, project);
      if (data && data.buckets) {
        base.models = _flattenBuckets(data.buckets);
      }
    } catch (err) {
      console.warn("[quota] Gemini CLI proxy fetch failed:", f.name, err.message);
    }
    return base;
  }));

  return { codex: codexResults, antigravity: antigravityResults, gemini: geminiResults };
}

// ── Data model ──

function buildQuotaData(cursorRaw, cpaData, cursorTotal) {
  const result = { cursor: null, cpa: null, updatedAt: Date.now() };

  // Cursor
  if (cursorRaw && typeof cursorRaw === "object") {
    const modelKeys = Object.keys(cursorRaw).filter((k) => k !== "startOfMonth");
    let totalUsed = 0;
    let maxUsage = cursorTotal || 500;
    for (const key of modelKeys) {
      const entry = cursorRaw[key];
      if (entry && typeof entry.numRequests === "number") totalUsed += entry.numRequests;
      if (entry && typeof entry.maxRequestUsage === "number") maxUsage = entry.maxRequestUsage;
    }
    const startOfMonth = cursorRaw.startOfMonth ? new Date(cursorRaw.startOfMonth) : null;
    let daysRemaining = 0;
    let resetDate = null;
    if (startOfMonth) {
      resetDate = new Date(startOfMonth);
      resetDate.setMonth(resetDate.getMonth() + 1);
      daysRemaining = Math.max(0, Math.ceil((resetDate - Date.now()) / 86400000));
    }
    const remaining = Math.max(0, maxUsage - totalUsed);
    const dailyAvg = daysRemaining > 0 ? +(remaining / daysRemaining).toFixed(1) : 0;

    result.cursor = {
      used: totalUsed,
      total: maxUsage,
      remaining,
      daysRemaining,
      dailyAvg,
      resetDate: resetDate ? resetDate.toISOString() : null,
      percent: maxUsage > 0 ? Math.round((totalUsed / maxUsage) * 100) : 0,
    };
  }

  // CPA — 已结构化的 { codex: [...], antigravity: [...] }
  if (cpaData) {
    result.cpa = cpaData;
  }

  return result;
}

// ── Secrets file (project root, gitignored) ──

const SECRETS_PATH = path.join(__dirname, "..", "quota-secrets.json");

function _readSecrets() {
  try {
    if (fs.existsSync(SECRETS_PATH)) {
      return JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
    }
  } catch {}
  return {};
}

// ── Quota manager ──

function initQuota(ctx) {
  let _timer = null;
  let _quotaData = { cursor: null, cpa: null, updatedAt: 0 };
  let _listeners = [];
  const _secrets = _readSecrets();

  function getQuotaData() {
    return _quotaData;
  }

  function onUpdate(fn) {
    _listeners.push(fn);
    return () => { _listeners = _listeners.filter((f) => f !== fn); };
  }

  function _notify() {
    for (const fn of _listeners) {
      try { fn(_quotaData); } catch {}
    }
  }

  async function refresh() {
    let cursorRaw = null;
    let cpaData = null;

    // Cursor
    try {
      const token = await readCursorToken();
      if (token) {
        const clientId = _secrets.cursorClientId || ctx.getQuotaPref("quotaCursorClientId");
        cursorRaw = await fetchCursorUsage(token, clientId);
      }
    } catch (err) {
      console.warn("[quota] Cursor fetch failed:", err.message);
    }

    // CPA（通过 api-call 代理获取真实额度）
    const cpaKey = _secrets.cpaKey || ctx.getQuotaPref("quotaCpaKey");
    if (cpaKey) {
      try {
        cpaData = await fetchFullCpaData(cpaKey);
      } catch (err) {
        console.warn("[quota] CPA fetch failed:", err.message);
      }
    }

    const cursorTotal = ctx.getQuotaPref("quotaCursorTotal") || 500;
    _quotaData = buildQuotaData(cursorRaw, cpaData, cursorTotal);
    _notify();
    return _quotaData;
  }

  function start() {
    const interval = ctx.getQuotaPref("quotaRefreshInterval") || 300000;
    refresh();
    if (_timer) clearInterval(_timer);
    _timer = setInterval(() => refresh(), interval);
  }

  function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  return {
    getQuotaData,
    refresh,
    onUpdate,
    start,
    stop,
  };
}

module.exports = initQuota;
module.exports.__test = {
  _buildAntigravityGroups,
  _isAgQuotaExhausted,
};
