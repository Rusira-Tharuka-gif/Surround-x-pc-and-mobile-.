const { app, BrowserWindow, shell } = require('electron');
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
          // SPA fallback only for extensionless navigation routes
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
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await createMainWindow();

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (staticServer) {
    try {
      staticServer.close();
    } catch {
      // Ignore shutdown errors
    }
    staticServer = null;
  }
});
