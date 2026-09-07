import net from 'node:net';

export function waitForPort(port, { host = '127.0.0.1', timeoutMs = 60000, intervalMs = 200 } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const socket = net.connect({ port, host });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tryOnce, intervalMs);
      });
    };
    tryOnce();
  });
}
