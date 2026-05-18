// [quota] contextBridge for quota-panel.html
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quotaAPI", {
  onQuotaData: (cb) => ipcRenderer.on("quota-data", (_, data) => cb(data)),
  onConfigUpdate: (cb) => ipcRenderer.on("quota-config", (_, data) => cb(data)),
  requestRefresh: () => ipcRenderer.send("quota-refresh"),
  reportHeight: (h) => ipcRenderer.send("quota-panel-height", h),
  saveConfig: (key, value) => ipcRenderer.send("quota-save-config", key, value),
  mouseEnter: () => ipcRenderer.send("quota-panel-mouse-enter"),
  mouseLeave: () => ipcRenderer.send("quota-panel-mouse-leave"),
  openSettings: () => ipcRenderer.send("quota-open-settings"),
});
