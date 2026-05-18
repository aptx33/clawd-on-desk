"use strict";

// src/quota-panel.js — Quota panel window management
// [quota] Independent module — manages BrowserWindow for hover card & tray panel.

const { BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");

const isMac = process.platform === "darwin";
const PANEL_WIDTH = 340;
const HOVER_SHOW_DELAY = 300;
const HOVER_HIDE_DELAY = 500;
const TRAY_REOPEN_GUARD_MS = 300;
const MAC_TOPMOST_LEVEL = "pop-up-menu";

function canShowHover(ctx) {
  if (ctx.miniMode) return false;
  if (ctx.isPetVisible && !ctx.isPetVisible()) return false;
  return true;
}

module.exports = function initQuotaPanel(ctx) {
  let _panelWin = null;
  let _panelHeight = 400;
  let _hoverShowTimer = null;
  let _hoverHideTimer = null;
  let _mouseInPanel = false;
  let _mode = null; // "hover" | "tray"
  let _lastTrayHideTime = 0;

  function _createWindow() {
    if (_panelWin && !_panelWin.isDestroyed()) return _panelWin;

    _panelWin = new BrowserWindow({
      width: PANEL_WIDTH,
      height: _panelHeight,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: _mode === "tray",
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, "preload-quota.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    if (isMac) {
      _panelWin.setAlwaysOnTop(true, MAC_TOPMOST_LEVEL);
      try {
        _panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch {}
    }

    _panelWin.loadFile(path.join(__dirname, "quota-panel.html"));

    // [调试] 打开 DevTools 微调样式，调试完删除下面两行
    // _panelWin.webContents.openDevTools({ mode: "detach" });
    // [调试] 面板加载完后自动以 tray 模式常驻显示，调试完删除
    // _panelWin.webContents.once("did-finish-load", () => { showTray(); });

    _panelWin.webContents.on("did-finish-load", () => {
      _sendData();
      _sendConfig();
    });

    _panelWin.on("blur", () => {
      if (_mode === "tray") {
        hidePanel();
      }
    });

    _panelWin.on("closed", () => { _panelWin = null; });

    return _panelWin;
  }

  function _sendData() {
    if (!_panelWin || _panelWin.isDestroyed()) return;
    const data = ctx.getQuotaData();
    _panelWin.webContents.send("quota-data", data);
  }

  function _sendConfig() {
    if (!_panelWin || _panelWin.isDestroyed()) return;
    _panelWin.webContents.send("quota-config", {
      quotaShowCursor: ctx.getQuotaPref("quotaShowCursor"),
      quotaShowCodex: ctx.getQuotaPref("quotaShowCodex"),
      quotaShowAntigravity: ctx.getQuotaPref("quotaShowAntigravity"),
      quotaShowGemini: ctx.getQuotaPref("quotaShowGemini"),
    });
  }

  // ── Positioning ──

  function _positionForHover() {
    if (!_panelWin || _panelWin.isDestroyed()) return;
    const petWin = ctx.win;
    if (!petWin || petWin.isDestroyed()) return;

    const bounds = petWin.getBounds();
    const hitRect = ctx.getHitRectScreen(bounds);

    // 角色右侧 +8px
    let x = Math.round(hitRect.right + 8);
    let y = Math.round((hitRect.top + hitRect.bottom) / 2 - _panelHeight / 2);

    // 检查是否超出屏幕，超出则改为左侧
    const wa = ctx.getNearestWorkArea(x, y);
    if (x + PANEL_WIDTH > wa.x + wa.width) {
      x = Math.round(hitRect.left - PANEL_WIDTH - 8);
    }
    // Y 边界钳制（底部留 20px 间距）
    const BOTTOM_MARGIN = 20;
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - _panelHeight - BOTTOM_MARGIN));

    _panelWin.setBounds({ x, y, width: PANEL_WIDTH, height: _panelHeight });
  }

  function _positionForTray() {
    if (!_panelWin || _panelWin.isDestroyed()) return;
    const tray = ctx.tray;
    if (!tray) return;

    const trayBounds = tray.getBounds();
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - PANEL_WIDTH / 2);
    let y = Math.round(trayBounds.y + trayBounds.height + 4);

    // 边界钳制
    try {
      const display = screen.getDisplayNearestPoint({ x, y });
      const wa = display.workArea;
      x = Math.max(wa.x, Math.min(x, wa.x + wa.width - PANEL_WIDTH));
      y = Math.max(wa.y, Math.min(y, wa.y + wa.height - _panelHeight));
    } catch {}

    _panelWin.setBounds({ x, y, width: PANEL_WIDTH, height: _panelHeight });
  }

  // ── Show / Hide ──

  function showHover() {
    if (!canShowHover(ctx)) return;
    if (ctx.pendingPermissions && ctx.pendingPermissions.length > 0) return;
    if (isVisible() && _mode === "hover") return;

    _mode = "hover";
    _createWindow();
    if (_panelWin.isDestroyed()) return;
    _panelWin.setFocusable(false);
    _positionForHover();
    _panelWin.showInactive();
    _sendData();
  }

  function showTray() {
    _mode = "tray";
    _createWindow();
    if (_panelWin.isDestroyed()) return;
    _panelWin.setFocusable(true);
    _positionForTray();
    _panelWin.show();
    _panelWin.focus();
    _sendData();
  }

  function hidePanel() {
    // [调试] 禁用隐藏，让面板常驻桌面方便 DevTools 微调，调试完删除下面的 return
    // return;
    _clearTimers();
    _mouseInPanel = false;
    if (_mode === "tray") _lastTrayHideTime = Date.now();
    if (_panelWin && !_panelWin.isDestroyed()) {
      _panelWin.hide();
    }
    _mode = null;
  }

  function isVisible() {
    return _panelWin && !_panelWin.isDestroyed() && _panelWin.isVisible();
  }

  function toggleTray() {
    if (isVisible() && _mode === "tray") {
      hidePanel();
    } else {
      // blur 事件导致面板刚关闭时，忽略本次 click 避免立即重新打开
      if (Date.now() - _lastTrayHideTime < TRAY_REOPEN_GUARD_MS) return;
      showTray();
    }
  }

  // ── Hover timers ──

  function _clearTimers() {
    if (_hoverShowTimer) { clearTimeout(_hoverShowTimer); _hoverShowTimer = null; }
    if (_hoverHideTimer) { clearTimeout(_hoverHideTimer); _hoverHideTimer = null; }
  }

  function scheduleHoverShow() {
    if (!canShowHover(ctx)) return;
    if (isVisible()) return;
    _clearTimers();
    _hoverShowTimer = setTimeout(() => {
      _hoverShowTimer = null;
      showHover();
    }, HOVER_SHOW_DELAY);
  }

  function scheduleHoverHide() {
    if (_mode !== "hover") return;
    _clearTimers();
    _hoverHideTimer = setTimeout(() => {
      _hoverHideTimer = null;
      if (!_mouseInPanel) {
        hidePanel();
      }
    }, HOVER_HIDE_DELAY);
  }

  function cancelHoverShow() {
    if (_hoverShowTimer) { clearTimeout(_hoverShowTimer); _hoverShowTimer = null; }
  }

  // ── IPC handlers ──

  ipcMain.on("quota-panel-height", (_event, height) => {
    if (typeof height === "number" && height > 0) {
      _panelHeight = Math.min(height + 2, 520);
      if (_panelWin && !_panelWin.isDestroyed() && _panelWin.isVisible()) {
        if (_mode === "hover") _positionForHover();
        else if (_mode === "tray") _positionForTray();
      }
    }
  });

  ipcMain.on("quota-refresh", () => {
    ctx.refreshQuota();
  });

  ipcMain.on("quota-save-config", (_event, key, value) => {
    ctx.setQuotaPref(key, value);
  });

  ipcMain.on("quota-panel-mouse-enter", () => {
    _mouseInPanel = true;
    _clearTimers();
  });

  ipcMain.on("quota-panel-mouse-leave", () => {
    _mouseInPanel = false;
    if (_mode === "hover") {
      scheduleHoverHide();
    }
  });

  ipcMain.on("quota-open-settings", () => {
    hidePanel();
    if (ctx.popUpTrayMenu) ctx.popUpTrayMenu();
  });

  // ── Data update subscription ──
  ctx.onQuotaUpdate(() => _sendData());

  return {
    showHover,
    showTray,
    hidePanel,
    toggleTray,
    isVisible,
    scheduleHoverShow,
    scheduleHoverHide,
    cancelHoverShow,
    sendData: _sendData,
  };
};

module.exports.__test = {
  canShowHover,
};
