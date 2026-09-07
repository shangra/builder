import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathExists } from './fs-utils.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const relative = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return null;
  }
  return resolved;
}

export async function startStaticServer({ dist, host = '0.0.0.0', port, spa = true }) {
  if (!(await pathExists(dist))) {
    throw new Error(`каталог статики не найден: ${dist}`);
  }

  const server = http.createServer((req, res) => {
    const target = safeJoin(dist, req.url || '/');
    if (!target) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const file = resolveFile(dist, target, spa);
    if (!file) {
      res.writeHead(404).end('Not found');
      return;
    }

    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function resolveFile(dist, target, spa) {
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    return target;
  }
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const index = path.join(target, 'index.html');
    if (fs.existsSync(index)) {
      return index;
    }
  }
  if (spa) {
    const fallback = path.join(dist, 'index.html');
    if (fs.existsSync(fallback)) {
      return fallback;
    }
  }
  return null;
}
