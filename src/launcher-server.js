import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { openUrl } from './open-url.js';

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'launcher-ui', 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

export function buildLauncherState(box, started = []) {
  const ui = box.ui;
  const startedById = new Map(started.map((item) => [item.id, item]));
  const modulesById = new Map((box.modules || []).map((mod) => [mod.id, mod]));

  const apps = (ui.apps || []).map((app) => {
    const mod = modulesById.get(app.module);
    const running = startedById.get(app.module);
    const url =
      app.url ||
      running?.url ||
      (mod?.port ? `http://127.0.0.1:${mod.port}` : null);
    return {
      id: app.id,
      title: app.title,
      subtitle: app.subtitle || '',
      module: app.module,
      url,
      ready: Boolean(url) && running?.live !== false,
    };
  });

  return {
    product: box.product,
    version: box.version,
    mode: ui.mode,
    apps,
  };
}

export async function startLauncherServer(box, started, options = {}) {
  const ui = box.ui;
  if (!ui?.enabled) {
    return null;
  }
  if (!fs.existsSync(path.join(uiDir, 'index.html'))) {
    throw new Error(
      'Нет сборки React-лаунчера (launcher-ui/dist).\nСоберите: npm run ui:build',
    );
  }

  let state = buildLauncherState(box, started);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/api/state') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(state));
      return;
    }
    serveUiFile(url.pathname, res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(ui.port, ui.host, resolve);
  });

  const shellUrl = `http://127.0.0.1:${ui.port}/`;
  logger.ok(`лаунчер ${shellUrl} · режим: ${ui.mode}`);

  const close = () =>
    new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

  const handle = {
    url: shellUrl,
    close,
    update(nextStarted) {
      state = buildLauncherState(box, nextStarted);
    },
  };

  if (!options.dryRun && ui.openOnStart && options.open !== false) {
    if (ui.mode === 'browser') {
      const targets = state.apps.map((app) => app.url).filter(Boolean);
      if (targets.length === 0) {
        openUrl(shellUrl);
      } else {
        for (const target of targets) {
          openUrl(target);
        }
      }
      logger.info('открываю приложения в браузере');
    } else {
      openUrl(shellUrl);
      logger.info('открываю оболочку лаунчера');
    }
  }

  return handle;
}

function serveUiFile(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(uiDir, relative);
  if (filePath !== uiDir && !filePath.startsWith(uiDir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const index = path.join(uiDir, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    fs.createReadStream(index).pipe(res);
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}
