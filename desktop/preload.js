'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prismDesktop', {
  isDesktopWidget: true,
  getPosition: () => ipcRenderer.invoke('widget:get-position'),
  getBounds: () => ipcRenderer.invoke('widget:get-bounds'),
  startDrag: () => ipcRenderer.send('widget:drag-start'),
  stepDrag: () => ipcRenderer.send('widget:drag-step'),
  endDrag: () => ipcRenderer.send('widget:drag-end'),
  moveWindow: (x, y) => ipcRenderer.send('widget:move', x, y),
  resizeWindow: (width, height) => ipcRenderer.send('widget:resize', width, height),
  setAlwaysOnTop: (enabled) => ipcRenderer.send('widget:set-always-on-top', enabled),
  setClickThrough: (enabled) => ipcRenderer.send('widget:set-click-through', enabled),
  setDockRect: (rect) => ipcRenderer.send('widget:dock-rect', rect),
  setDockLock: (locked) => ipcRenderer.send('widget:dock-lock', locked),
  setDockHover: (hovered) => ipcRenderer.send('widget:dock-hover', hovered),
  openLab: () => ipcRenderer.send('widget:open-lab'),
  showContextMenu: () => ipcRenderer.send('widget:context-menu'),
  closeWidget: () => ipcRenderer.send('widget:close'),
  savePrefs: (prefs) => ipcRenderer.send('widget:save-prefs', prefs),
  loadPrefs: () => ipcRenderer.invoke('widget:load-prefs'),
  onStateSync: (cb) => ipcRenderer.on('widget:state-sync', (_e, payload) => cb(payload)),
  onDockHoverState: (cb) => ipcRenderer.on('widget:dock-hover-state', (_e, hovered) => cb(hovered)),
  onBoardUpdated: (cb) => ipcRenderer.on('widget:board-updated', () => cb())
});
