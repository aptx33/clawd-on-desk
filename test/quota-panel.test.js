const { describe, it } = require("node:test");
const assert = require("node:assert");

const quotaPanel = require("../src/quota-panel");

describe("quota panel hover guard", () => {
  it("pet 自动隐藏后不再允许 hover 弹出额度面板", () => {
    assert.strictEqual(
      quotaPanel.__test.canShowHover({
        miniMode: false,
        isPetVisible: () => false,
      }),
      false
    );
  });

  it("mini mode 下不允许 hover 弹出额度面板", () => {
    assert.strictEqual(
      quotaPanel.__test.canShowHover({
        miniMode: true,
        isPetVisible: () => true,
      }),
      false
    );
  });

  it("宠物可见且非 mini mode 时允许 hover 弹出额度面板", () => {
    assert.strictEqual(
      quotaPanel.__test.canShowHover({
        miniMode: false,
        isPetVisible: () => true,
      }),
      true
    );
  });
});
