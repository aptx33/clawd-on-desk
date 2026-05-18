const { describe, it } = require("node:test");
const assert = require("node:assert");

const quota = require("../src/quota");

describe("antigravity quota grouping", () => {
  it("Claude 和 GPT 拆分为独立分组", () => {
    const groups = quota.__test._buildAntigravityGroups([
      { modelId: "claude-sonnet-4-6", remainingFraction: 0.8, resetTime: "2026-05-22T03:22:18Z" },
      { modelId: "claude-opus-4-6-thinking", remainingFraction: 0.6, resetTime: "2026-05-22T03:22:18Z" },
      { modelId: "gpt-oss-120b-medium", remainingFraction: 0.5, resetTime: "2026-05-22T03:22:18Z" },
    ], "active", "");

    const claude = groups.find((g) => g.label === "Claude");
    const gpt = groups.find((g) => g.label === "GPT");

    assert.ok(claude, "应存在独立的 Claude 分组");
    assert.strictEqual(claude.remainingFraction, 0.6);
    assert.deepStrictEqual(claude.modelIds.sort(), ["claude-opus-4-6-thinking", "claude-sonnet-4-6"]);

    assert.ok(gpt, "应存在独立的 GPT 分组");
    assert.strictEqual(gpt.remainingFraction, 0.5);
    assert.deepStrictEqual(gpt.modelIds, ["gpt-oss-120b-medium"]);

    assert.ok(!groups.find((g) => g.label === "Claude/GPT"), "不应存在合并的 Claude/GPT 分组");
  });

  it("RESOURCE_EXHAUSTED 时 Claude 和 GPT 分别强制 0%", () => {
    const groups = quota.__test._buildAntigravityGroups([
      { modelId: "claude-sonnet-4-6", remainingFraction: 1, resetTime: "2026-05-22T03:22:18Z" },
      { modelId: "gpt-oss-120b-medium", remainingFraction: 1, resetTime: "2026-05-22T03:22:18Z" },
      { modelId: "gemini-3.1-pro-low", remainingFraction: 1, resetTime: "2026-05-22T03:22:18Z" },
    ], "error", "RESOURCE_EXHAUSTED");

    const claude = groups.find((g) => g.label === "Claude");
    const gpt = groups.find((g) => g.label === "GPT");
    const geminiPro = groups.find((g) => g.label === "Gemini 3.1 Pro Series");

    assert.ok(claude);
    assert.strictEqual(claude.remainingFraction, 0);
    assert.strictEqual(claude.resetTime, null);

    assert.ok(gpt);
    assert.strictEqual(gpt.remainingFraction, 0);
    assert.strictEqual(gpt.resetTime, null);

    assert.ok(geminiPro);
    assert.strictEqual(geminiPro.remainingFraction, 1, "Gemini 不受 exhausted 影响");
  });

  it("remainingFraction 缺失时视为 0（已耗尽）", () => {
    const groups = quota.__test._buildAntigravityGroups([
      { modelId: "claude-sonnet-4-6", remainingFraction: 0, resetTime: "2026-05-16T16:30:16Z" },
      { modelId: "gpt-oss-120b-medium", remainingFraction: 0, resetTime: "2026-05-16T16:30:16Z" },
      { modelId: "gemini-2.5-flash", remainingFraction: 1, resetTime: "2026-05-16T20:25:02Z" },
    ], "active", "");

    const claude = groups.find((g) => g.label === "Claude");
    const gpt = groups.find((g) => g.label === "GPT");
    const flash = groups.find((g) => g.label === "Gemini 2.5 Flash");

    assert.strictEqual(claude.remainingFraction, 0);
    assert.strictEqual(claude.resetTime, "2026-05-16T16:30:16Z");

    assert.strictEqual(gpt.remainingFraction, 0);

    assert.strictEqual(flash.remainingFraction, 1);
  });

  it("Gemini 分组按最差剩余额度和最早重置时间聚合", () => {
    const groups = quota.__test._buildAntigravityGroups([
      { modelId: "gemini-pro-agent", remainingFraction: 1, resetTime: "2026-05-22T03:22:18Z" },
      { modelId: "gemini-3.1-pro-low", remainingFraction: 0.75, resetTime: "2026-05-20T03:22:18Z" },
    ], "active", "");

    const geminiPro = groups.find((group) => group.label === "Gemini 3.1 Pro Series");
    assert.ok(geminiPro);
    assert.strictEqual(geminiPro.remainingFraction, 0.75);
    assert.strictEqual(geminiPro.resetTime, "2026-05-20T03:22:18Z");
  });
});

describe("_isAgQuotaExhausted", () => {
  it("识别 RESOURCE_EXHAUSTED", () => {
    assert.ok(quota.__test._isAgQuotaExhausted("error", "RESOURCE_EXHAUSTED"));
    assert.ok(quota.__test._isAgQuotaExhausted("error", "429 RESOURCE_EXHAUSTED: quota exceeded"));
    assert.ok(!quota.__test._isAgQuotaExhausted("active", ""));
  });
});
