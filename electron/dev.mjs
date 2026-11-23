import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronBinary from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const viteBin = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');
const devUrl = 'http://127.0.0.1:3000';

function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for Vite dev server at ${url}`));
          return;
        }
        setTimeout(check, 250);
      });
    };
    check();
  });
}

const viteProc = spawn(
  process.execPath,
  [viteBin, '--port=3000', '--host=127.0.0.1'],
  {
    cwd: rootDir,
    stdio: 'inherit',
  }
);

let electronProc = null;

function shutdown(exitCode = 0) {
  if (electronProc && !electronProc.killed) {
    electronProc.kill();
  }
  if (!viteProc.killed) {
    viteProc.kill();
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

viteProc.on('exit', (code) => {
  if (!electronProc) {
    process.exit(code ?? 1);
  }
});

try {
  await waitForServer(devUrl);
  electronProc = spawn(String(electronBinary), ['.'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_DEV_URL: devUrl,
    },
  });

  electronProc.on('exit', (code) => {
    shutdown(code ?? 0);
  });
} catch (err) {
  console.error(err);
  shutdown(1);
}
