const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  ipcMain,
  nativeImage,
  shell,
} = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ac3': 'audio/ac3',
  '.dts': 'audio/vnd.dts',
  '.flac': 'audio/flac',
};

let staticServer = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let backgroundNoticeShownForJob = false;

let activeConversion = {
  status: 'idle',
  filename: '',
  progressPct: 0,
  outputFilename: '',
  formatLabel: '',
  sizeLabel: '',
  message: '',
};

function resolveIconPath() {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(__dirname, 'icon.ico'),
          path.join(__dirname, '..', 'build', 'icon.ico'),
          path.join(__dirname, 'icon.png'),
        ]
      : [
          path.join(__dirname, 'icon.png'),
          path.join(__dirname, '..', 'build', 'icon.png'),
        ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveNotificationIconPath() {
  const candidates = [
    path.join(__dirname, 'icon.png'),
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(__dirname, 'icon.ico'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
  mainWindow.flashFrame(false);
}

function showDesktopNotification(title, body) {
  try {
    if (Notification.isSupported()) {
      const icon = resolveNotificationIconPath();
      const notif = new Notification({
        title,
        body,
        icon,
        silent: false,
      });
      notif.on('click', () => {
        showMainWindow();
      });
      notif.show();
      return;
    }
  } catch (err) {
    console.warn('[Surround X][Electron] Notification error:', err);
  }

  if (tray && process.platform === 'win32') {
    try {
      tray.displayBalloon({
        iconType: 'info',
        title,
        content: body,
      });
    } catch {
      // Ignore balloon fallback errors
    }
  }
}

function formatTrayStatusLabel() {
  switch (activeConversion.status) {
    case 'converting': {
      const pct = Math.max(0, Math.min(100, Math.round(activeConversion.progressPct || 0)));
      const file = activeConversion.filename ? ` · ${activeConversion.filename}` : '';
      return `Converting${file} (${pct}%)`;
    }
    case 'completed':
      return `Ready: ${activeConversion.outputFilename || 'Converted audio'}`;
    case 'error':
      return 'Last conversion failed';
    case 'cancelled':
      return 'Conversion cancelled';
    default:
      return 'Status: Idle · Console Ready';
  }
}

function updateTrayUI() {
  if (!tray || tray.isDestroyed()) return;

  const statusLabel = formatTrayStatusLabel();
  const tooltip =
    activeConversion.status === 'converting'
      ? `Surround X — ${statusLabel}`
      : 'Surround X — Spatial Audio Studio';
  tray.setToolTip(tooltip.slice(0, 127));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Surround X',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: statusLabel,
      enabled: false,
    },
    ...(activeConversion.status === 'converting'
      ? [
          {
            label: 'Running in background (safe to work in other apps)',
            enabled: false,
          },
        ]
      : []),
    { type: 'separator' },
    {
      label: 'Quit Surround X',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray() {
  if (tray) return;
  const iconPath = resolveIconPath();
  let trayImg = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (trayImg.isEmpty()) {
    const pngFallback = resolveNotificationIconPath();
    if (pngFallback) {
      trayImg = nativeImage.createFromPath(pngFallback);
    }
  }

  tray = new Tray(trayImg);
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  tray.on('balloon-click', () => showMainWindow());
  updateTrayUI();
}

function startDistServer(distDir) {
  return new Promise((resolve, reject) => {
    const resolvedRoot = path.resolve(distDir);

    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
        let pathname = decodeURIComponent(reqUrl.pathname);
        if (pathname === '/') {
          pathname = '/index.html';
        }

        const candidatePath = path.resolve(resolvedRoot, `.${pathname}`);
        if (!candidatePath.startsWith(resolvedRoot)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }

        let filePath = candidatePath;
        const exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();

        if (!exists) {
          if (!path.extname(pathname)) {
            filePath = path.join(resolvedRoot, 'index.html');
          } else {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
          }
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const stat = fs.statSync(filePath);

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': stat.size,
          'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
        });

        fs.createReadStream(filePath).pipe(res);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(err && err.message ? err.message : 'Internal server error');
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind local static server'));
        return;
      }
      staticServer = server;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function createMainWindow() {
  const devUrl = process.env.ELECTRON_DEV_URL;
  const distDir = path.join(__dirname, '..', 'dist');
  const startUrl = devUrl ? devUrl : await startDistServer(distDir);
  const allowedOrigin = new URL(startUrl).origin;
  const iconPath = resolveIconPath();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Surround X',
    backgroundColor: '#07090E',
    icon: iconPath,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Keep Web Workers, FFmpeg WASM, and DSP timers running at full speed when minimized or in tray
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  mainWindow.on('minimize', () => {
    if (activeConversion.status === 'converting' && !backgroundNoticeShownForJob) {
      backgroundNoticeShownForJob = true;
      showDesktopNotification(
        'Surround X is converting in the background',
        `Processing ${activeConversion.filename || 'your audio'} (${Math.round(activeConversion.progressPct || 0)}%). You will be notified when it completes.`,
      );
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && activeConversion.status === 'converting') {
      event.preventDefault();
      mainWindow.hide();
      if (!backgroundNoticeShownForJob) {
        backgroundNoticeShownForJob = true;
        showDesktopNotification(
          'Surround X is still running in the background',
          `Converting ${activeConversion.filename || 'audio'} (${Math.round(activeConversion.progressPct || 0)}%). Click the Surround X system tray icon to reopen.`,
        );
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(allowedOrigin) || url.startsWith('blob:')) {
      return { action: 'allow' };
    }
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedOrigin) && !url.startsWith('blob:')) {
      event.preventDefault();
      if (url.startsWith('https://') || url.startsWith('http://')) {
        shell.openExternal(url);
      }
    }
  });

  await mainWindow.loadURL(startUrl);
}

app.setName('Surround X');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.surroundx.studio');
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    createTray();
    await createMainWindow();

    ipcMain.handle('surround:show-window', () => {
      showMainWindow();
    });

    ipcMain.on('surround:conversion-state', (_event, payload) => {
      if (!payload || typeof payload !== 'object') return;
      const prevStatus = activeConversion.status;
      activeConversion = {
        status: payload.status || 'idle',
        filename: String(payload.filename || ''),
        progressPct: Number(payload.progressPct || 0),
        outputFilename: String(payload.outputFilename || ''),
        formatLabel: String(payload.formatLabel || ''),
        sizeLabel: String(payload.sizeLabel || ''),
        message: String(payload.message || ''),
      };

      if (activeConversion.status === 'converting' && prevStatus !== 'converting') {
        backgroundNoticeShownForJob = false;
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        if (activeConversion.status === 'converting') {
          const ratio = Math.max(0.02, Math.min(1, (activeConversion.progressPct || 0) / 100));
          mainWindow.setProgressBar(ratio);
        } else {
          mainWindow.setProgressBar(-1);
        }
      }

      updateTrayUI();

      if (activeConversion.status === 'completed') {
        const outName = activeConversion.outputFilename || 'Converted audio';
        const meta = [activeConversion.sizeLabel, activeConversion.formatLabel]
          .filter(Boolean)
          .join(' · ');
        showDesktopNotification(
          'Surround X — Conversion Complete',
          meta ? `${outName} (${meta}) is ready to play or save.` : `${outName} is ready to play or save.`,
        );
        if (mainWindow && !mainWindow.isDestroyed() && (!mainWindow.isVisible() || !mainWindow.isFocused())) {
          mainWindow.flashFrame(true);
        }
      } else if (activeConversion.status === 'error') {
        showDesktopNotification(
          'Surround X — Conversion Failed',
          activeConversion.message || 'Audio conversion failed. Click to inspect details.',
        );
        if (mainWindow && !mainWindow.isDestroyed() && (!mainWindow.isVisible() || !mainWindow.isFocused())) {
          mainWindow.flashFrame(true);
        }
      }
    });

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow();
      } else {
        showMainWindow();
      }
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (isQuitting || activeConversion.status !== 'converting')) {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (tray && !tray.isDestroyed()) {
    try {
      tray.destroy();
    } catch {
      // Ignore tray cleanup errors
    }
    tray = null;
  }
  if (staticServer) {
    try {
      staticServer.close();
    } catch {
      // Ignore shutdown errors
    }
    staticServer = null;
  }
});
