'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  screen,
  nativeImage,
  globalShortcut
} = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const ROOT_DIR = path.resolve(__dirname, '..');
const STATE_FILE = path.join(app.getPath('userData'), 'prismclock-widget-state.json');
const ICON_PNG = path.join(__dirname, 'icon.png');

let clockWin = null;
let labWin = null;
let tray = null;

// Smart click-through state: when clickThrough is ON, the clock board passes clicks through
// while hovering the bottom dock temporarily re-enables mouse input so you can always unlock.
let dockHovered = false;
let dockLock = false;
let dockRect = null; // { left, top, right, bottom } in window-relative DIPs
let clickThroughTimer = null;
let dragOrigin = null;
let dragTimer = null;

let widgetState = {
  x: null,
  y: null,
  width: 390,
  height: 535,
  alwaysOnTop: true,
  clickThrough: false,
  boardId: 'clockwork',
  rhythm: 'cascade',
  faceMode: 'digital',
  bgMode: 'transparent'
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        widgetState = Object.assign(widgetState, parsed);
      }
    }
  } catch (err) {
    console.error('Failed to load widget state:', err);
  }
}

function saveState() {
  try {
    if (clockWin && !clockWin.isDestroyed()) {
      const b = clockWin.getBounds();
      widgetState.x = b.x;
      widgetState.y = b.y;
      widgetState.width = b.width;
      widgetState.height = b.height;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(widgetState, null, 2));
  } catch (err) {
    console.error('Failed to save widget state:', err);
  }
}

function getAppIcon() {
  if (fs.existsSync(ICON_PNG)) {
    return nativeImage.createFromPath(ICON_PNG);
  }
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="8" fill="#0b1220"/>
      <polygon points="16,4 28,16 16,28 4,16" fill="none" stroke="#38bdf8" stroke-width="2.5"/>
      <circle cx="16" cy="16" r="4" fill="#f59e0b"/>
    </svg>`;
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  );
}

function isRectVisibleOnAnyDisplay(x, y, w, h) {
  const displays = screen.getAllDisplays();
  for (const d of displays) {
    const wa = d.workArea;
    const overlapW = Math.min(x + w, wa.x + wa.width) - Math.max(x, wa.x);
    const overlapH = Math.min(y + h, wa.y + wa.height) - Math.max(y, wa.y);
    if (overlapW >= 60 && overlapH >= 60) return true;
  }
  return false;
}

function safeSetBounds(bounds) {
  if (!clockWin || clockWin.isDestroyed()) return;
  // On Windows, toggling resizable around setBounds avoids non-client DWM frame glitches
  // and keeps exact DIP dimensions across mixed-DPI displays.
  clockWin.setResizable(true);
  clockWin.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  });
  clockWin.setResizable(false);
}

function syncIgnoreMouse() {
  if (!clockWin || clockWin.isDestroyed()) return;
  const shouldIgnore = Boolean(widgetState.clickThrough && !dockHovered && !dockLock);
  if (shouldIgnore) {
    clockWin.setIgnoreMouseEvents(true, { forward: true });
  } else {
    clockWin.setIgnoreMouseEvents(false);
  }
}

function pollCursorOverDock() {
  if (!clockWin || clockWin.isDestroyed() || !widgetState.clickThrough) {
    stopClickThroughMonitor();
    return;
  }
  const pt = screen.getCursorScreenPoint();
  const b = clockWin.getBounds();
  const rx = pt.x - b.x;
  const ry = pt.y - b.y;
  const pad = 10;

  let insideDock = false;
  if (dockRect && dockRect.right > dockRect.left && dockRect.bottom > dockRect.top) {
    insideDock =
      rx >= dockRect.left - pad &&
      rx <= dockRect.right + pad &&
      ry >= dockRect.top - pad &&
      ry <= dockRect.bottom + pad;
  } else {
    insideDock = rx >= 0 && rx <= b.width && ry >= b.height - 96 && ry <= b.height;
  }

  const nextHovered = Boolean(insideDock || dockLock);
  if (nextHovered !== dockHovered) {
    dockHovered = nextHovered;
    syncIgnoreMouse();
    clockWin.webContents.send('widget:dock-hover-state', dockHovered);
  }
}

function startClickThroughMonitor() {
  if (clickThroughTimer) return;
  clickThroughTimer = setInterval(pollCursorOverDock, 60);
  pollCursorOverDock();
}

function stopClickThroughMonitor() {
  if (clickThroughTimer) {
    clearInterval(clickThroughTimer);
    clickThroughTimer = null;
  }
}

function applyWindowFlags() {
  if (!clockWin || clockWin.isDestroyed()) return;
  clockWin.setAlwaysOnTop(Boolean(widgetState.alwaysOnTop), 'floating');
  if (widgetState.clickThrough) {
    startClickThroughMonitor();
  } else {
    stopClickThroughMonitor();
    dockHovered = false;
    dockLock = false;
    clockWin.webContents.send('widget:dock-hover-state', false);
  }
  syncIgnoreMouse();
  clockWin.webContents.send('widget:state-sync', {
    alwaysOnTop: Boolean(widgetState.alwaysOnTop),
    clickThrough: Boolean(widgetState.clickThrough)
  });
  rebuildTrayMenu();
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: Boolean(widgetState.alwaysOnTop),
      click: (item) => {
        widgetState.alwaysOnTop = item.checked;
        applyWindowFlags();
        saveState();
      }
    },
    {
      label: 'Click-Through Board (Ctrl+Shift+T)',
      type: 'checkbox',
      checked: Boolean(widgetState.clickThrough),
      click: (item) => {
        widgetState.clickThrough = item.checked;
        dockHovered = false;
        dockLock = false;
        applyWindowFlags();
        saveState();
      }
    },
    { type: 'separator' },
    {
      label: 'Open PrismDrop Design Lab',
      click: () => openLabWindow()
    },
    {
      label: 'Reset Position & Size',
      click: () => {
        if (!clockWin || clockWin.isDestroyed()) return;
        const wa = screen.getPrimaryDisplay().workArea;
        safeSetBounds({
          x: wa.x + wa.width - 420,
          y: wa.y + wa.height - 565,
          width: 390,
          height: 535
        });
        saveState();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit PrismDrop',
      click: () => {
        saveState();
        app.quit();
      }
    }
  ]);
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildContextMenu());
}

function createClockWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.max(220, Math.min(900, Math.round(widgetState.width || 390)));
  const h = Math.max(280, Math.min(1100, Math.round(widgetState.height || 535)));

  let x = Number.isFinite(widgetState.x) ? Math.round(widgetState.x) : Math.round(wa.x + wa.width - w - 32);
  let y = Number.isFinite(widgetState.y) ? Math.round(widgetState.y) : Math.round(wa.y + wa.height - h - 32);

  if (!isRectVisibleOnAnyDisplay(x, y, w, h)) {
    x = Math.round(wa.x + wa.width - w - 32);
    y = Math.round(wa.y + wa.height - h - 32);
  }

  clockWin = new BrowserWindow({
    x,
    y,
    width: w,
    height: h,
    frame: false,
    transparent: true,
    thickFrame: false,
    hasShadow: false,
    autoHideMenuBar: true,
    alwaysOnTop: Boolean(widgetState.alwaysOnTop),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    icon: getAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  clockWin.setMinimumSize(1, 1);
  clockWin.setMenuBarVisibility(false);

  const startTransparent = widgetState.bgMode !== 'obsidian';
  clockWin.loadFile(path.join(ROOT_DIR, 'clock.html'), {
    query: {
      widget: '1',
      transparent: startTransparent ? '1' : '0',
      rhythm: widgetState.rhythm || 'cascade',
      face: widgetState.faceMode || 'digital',
      board: widgetState.boardId || 'clockwork'
    }
  });

  clockWin.webContents.on('did-finish-load', () => {
    applyWindowFlags();
  });

  clockWin.on('blur', () => {
    stopDragTracking(true);
  });

  clockWin.on('closed', () => {
    stopDragTracking(false);
    stopClickThroughMonitor();
    saveState();
    clockWin = null;
  });
}

function openLabWindow() {
  if (labWin && !labWin.isDestroyed()) {
    labWin.focus();
    return;
  }

  labWin = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: 'PrismDrop — Design Lab',
    backgroundColor: '#090d16',
    icon: getAppIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  labWin.setMenuBarVisibility(false);
  labWin.loadFile(path.join(ROOT_DIR, 'index.html'));

  labWin.on('blur', () => {
    if (clockWin && !clockWin.isDestroyed()) {
      clockWin.webContents.send('widget:board-updated');
    }
  });

  labWin.on('closed', () => {
    if (clockWin && !clockWin.isDestroyed()) {
      clockWin.webContents.send('widget:board-updated');
    }
    labWin = null;
  });
}

// IPC Handlers
ipcMain.handle('widget:get-position', () => {
  if (!clockWin || clockWin.isDestroyed()) return [0, 0];
  return clockWin.getPosition();
});

ipcMain.handle('widget:get-bounds', () => {
  if (!clockWin || clockWin.isDestroyed()) return { x: 0, y: 0, width: 390, height: 535 };
  return clockWin.getBounds();
});

ipcMain.handle('widget:load-prefs', () => ({ ...widgetState }));

function stopDragTracking(persist) {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (dragOrigin) {
    dragOrigin = null;
    if (persist) saveState();
  }
}

ipcMain.on('widget:drag-start', () => {
  if (!clockWin || clockWin.isDestroyed()) return;
  stopDragTracking(false);
  dragOrigin = {
    cursor: screen.getCursorScreenPoint(),
    bounds: clockWin.getBounds(),
    lastX: null,
    lastY: null
  };
});

ipcMain.on('widget:drag-step', () => {
  if (!clockWin || clockWin.isDestroyed() || !dragOrigin) return;
  const applyStep = () => {
    if (!clockWin || clockWin.isDestroyed() || !dragOrigin) {
      stopDragTracking(false);
      return;
    }
    const cur = screen.getCursorScreenPoint();
    const nx = Math.round(dragOrigin.bounds.x + (cur.x - dragOrigin.cursor.x));
    const ny = Math.round(dragOrigin.bounds.y + (cur.y - dragOrigin.cursor.y));
    if (nx === dragOrigin.lastX && ny === dragOrigin.lastY) return;
    dragOrigin.lastX = nx;
    dragOrigin.lastY = ny;
    safeSetBounds({
      x: nx,
      y: ny,
      width: dragOrigin.bounds.width,
      height: dragOrigin.bounds.height
    });
  };
  applyStep();
  if (!dragTimer) {
    dragTimer = setInterval(applyStep, 16);
  }
});

ipcMain.on('widget:drag-end', () => {
  stopDragTracking(true);
});

ipcMain.on('widget:move', (_e, x, y) => {
  if (clockWin && !clockWin.isDestroyed()) {
    const b = clockWin.getBounds();
    safeSetBounds({ x, y, width: b.width, height: b.height });
  }
});

ipcMain.on('widget:resize', (_e, width, height) => {
  if (clockWin && !clockWin.isDestroyed()) {
    const b = clockWin.getBounds();
    const w = Math.max(220, Math.min(960, Math.round(width)));
    const h = Math.max(280, Math.min(1150, Math.round(height)));
    safeSetBounds({ x: b.x, y: b.y, width: w, height: h });
    saveState();
  }
});

ipcMain.on('widget:set-always-on-top', (_e, enabled) => {
  widgetState.alwaysOnTop = Boolean(enabled);
  applyWindowFlags();
  saveState();
});

ipcMain.on('widget:set-click-through', (_e, enabled) => {
  widgetState.clickThrough = Boolean(enabled);
  if (!widgetState.clickThrough) {
    dockHovered = false;
    dockLock = false;
  }
  applyWindowFlags();
  saveState();
});

ipcMain.on('widget:dock-rect', (_e, rect) => {
  if (rect && typeof rect === 'object') {
    dockRect = {
      left: Number(rect.left) || 0,
      top: Number(rect.top) || 0,
      right: Number(rect.right) || 0,
      bottom: Number(rect.bottom) || 0
    };
  }
});

ipcMain.on('widget:dock-lock', (_e, locked) => {
  dockLock = Boolean(locked);
  syncIgnoreMouse();
});

ipcMain.on('widget:dock-hover', (_e, hovered) => {
  dockHovered = Boolean(hovered);
  syncIgnoreMouse();
});

ipcMain.on('widget:save-prefs', (_e, prefs) => {
  if (prefs && typeof prefs === 'object') {
    Object.assign(widgetState, prefs);
    saveState();
  }
});

ipcMain.on('widget:open-lab', () => openLabWindow());

ipcMain.on('widget:context-menu', () => {
  if (!clockWin || clockWin.isDestroyed()) return;
  buildContextMenu().popup({ window: clockWin });
});

ipcMain.on('widget:close', () => {
  saveState();
  app.quit();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  loadState();

  tray = new Tray(getAppIcon().resize({ width: 16, height: 16 }));
  tray.setToolTip('PrismDrop — Live Pachinko Desktop Clock');
  tray.on('click', () => {
    if (clockWin && !clockWin.isDestroyed()) {
      clockWin.show();
      clockWin.focus();
    }
  });
  rebuildTrayMenu();

  globalShortcut.register('CommandOrControl+Shift+T', () => {
    widgetState.clickThrough = !widgetState.clickThrough;
    dockHovered = false;
    dockLock = false;
    applyWindowFlags();
    saveState();
  });

  if (process.argv.includes('--lab')) {
    openLabWindow();
  } else {
    createClockWindow();
  }
});

app.on('will-quit', () => {
  stopClickThroughMonitor();
  globalShortcut.unregisterAll();
  saveState();
});

app.on('window-all-closed', () => {
  stopClickThroughMonitor();
  saveState();
  if (process.platform !== 'darwin') app.quit();
});
