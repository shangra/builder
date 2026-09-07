import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { orderModules } from './box.config.js';
import { loadEnvFile } from './env-file.js';
import { killChildren, spawnCommand } from './exec.js';
import { pathExists } from './fs-utils.js';
import { startLauncherServer } from './launcher-server.js';
import { logger } from './logger.js';
import { boxInstallCommand } from './install-box.js';
import { waitForPort } from './wait-port.js';
import { startStaticServer } from './static-server.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBox(box, modules, options = {}) {
  const supervisor = new Supervisor(box, modules, options);
  return supervisor.run();
}

class Supervisor {
  constructor(box, modules, options) {
    this.box = box;
    this.modules = orderModules(modules);
    this.options = options;
    this.stopping = false;
    this.statics = [];
    this.serviceWaits = [];
    this.stopResolvers = [];
    this.started = [];
    this.launcher = null;
  }

  async run() {
    const onStop = () => {
      logger.warn('остановка коробки...');
      this.stopping = true;
      killChildren();
      for (const item of this.statics) {
        item.close?.().catch(() => {});
      }
      for (const resolve of this.stopResolvers) {
        resolve();
      }
    };
    process.on('SIGINT', onStop);
    process.on('SIGTERM', onStop);

    try {
      await fsp.mkdir(this.box.logsDir, { recursive: true });
      if (this.box.clearLogs) {
        try {
          const logFiles = await fsp.readdir(this.box.logsDir);
          for (const file of logFiles) {
            if (file.endsWith('.log')) {
              await fsp.unlink(path.join(this.box.logsDir, file));
            }
          }
        } catch {
          // ignore if logs dir is empty or unreadable
        }
      }

      for (const mod of this.modules) {
        if (this.stopping) {
          break;
        }
        await this.boot(mod);
      }

      if (this.stopping) {
        return { ok: false, started: this.started };
      }

      this.printReady();
      if (this.options.dryRun) {
        return { ok: true, started: this.started };
      }

      if (this.box.ui?.enabled) {
        const launcher = await startLauncherServer(this.box, this.started, {
          open: this.options.openUi !== false,
        });
        if (launcher) {
          this.launcher = launcher;
          this.statics.push(launcher);
          this.serviceWaits.push(
            new Promise((resolve) => {
              this.stopResolvers.push(resolve);
            }),
          );
        }
      }

      if (this.serviceWaits.length === 0) {
        logger.ok('oneshot-модули выполнены, долгоживущих сервисов нет');
        return { ok: true, started: this.started };
      }
      await Promise.all(this.serviceWaits);
      return { ok: !this.stopping, started: this.started, interrupted: this.stopping };
    } finally {
      process.off('SIGINT', onStop);
      process.off('SIGTERM', onStop);
    }
  }

  async boot(mod) {
    if (this.box.fastStart && mod.kind === 'oneshot') {
      logger.info(`${mod.id}: fastStart — пропускаю oneshot`);
      return;
    }

    if (!mod.exists) {
      if (mod.optional) {
        logger.warn(`${mod.id}: нет каталога ${mod.absDir}, optional - пропуск`);
        return;
      }
      throw new Error(`${mod.id}: каталог не найден: ${mod.absDir}`);
    }

    if ((mod.kind === 'service' || mod.kind === 'oneshot') && !mod.start) {
      if (mod.optional) {
        logger.warn(`${mod.id}: нет команды start, optional - пропуск`);
        return;
      }
      throw new Error(`${mod.id}: не задан start и нет scripts.start / scripts.dev`);
    }

    const hasStaticBuild =
      Boolean(mod.distDir) && (await pathExists(path.join(mod.distDir, 'index.html')));
    const useStatic =
      mod.kind === 'static' ||
      (this.box.preferStatic !== false && hasStaticBuild && mod.port);

    if (useStatic) {
      await this.bootStatic(mod);
      return;
    }

    if (mod.kind === 'oneshot') {
      await this.bootOneshot(mod);
      return;
    }

    await this.bootService(mod);
  }

  async bootStatic(mod) {
    const dist = mod.distDir;
    const port = Number(mod.port);
    if (!port) {
      throw new Error(`${mod.id}: для kind=static нужен порт`);
    }
    logger.pkg(mod.id, this.options.dryRun ? `dry-run static ${dist} :${port}` : `static ${dist} :${port}`);
    if (this.options.dryRun) {
      this.started.push({ id: mod.id, kind: 'static', url: `http://127.0.0.1:${port}` });
      return;
    }
    const server = await startStaticServer({
      dist,
      host: mod.host,
      port,
      spa: mod.spa,
    });
    this.statics.push(server);
    this.started.push({ id: mod.id, kind: 'static', url: server.url, live: true });
    this.serviceWaits.push(
      new Promise((resolve) => {
        this.stopResolvers.push(resolve);
      }),
    );
    logger.ok(`${mod.id} ${server.url}`);
  }

  async bootOneshot(mod) {
    const command = await this.prepareCommand(mod);
    if (!command) {
      return;
    }
    logger.pkg(mod.id, this.options.dryRun ? `dry-run ${command}` : command);
    if (this.options.dryRun) {
      this.started.push({ id: mod.id, kind: 'oneshot' });
      return;
    }
    const result = await this.spawnOnce(mod, command, { persist: false });
    if (result.code !== 0) {
      if (mod.optional) {
        logger.warn(`${mod.id}: oneshot завершился с кодом ${result.code}, optional - дальше`);
        return;
      }
      throw new Error(`${mod.id}: oneshot завершился с кодом ${result.code}`);
    }
    this.started.push({ id: mod.id, kind: 'oneshot' });
    logger.ok(`${mod.id} выполнен`);
  }

  async bootService(mod) {
    const command = await this.prepareCommand(mod);
    if (!command) {
      return;
    }
    logger.pkg(mod.id, this.options.dryRun ? `dry-run ${command}` : command);
    if (this.options.dryRun) {
      this.started.push({
        id: mod.id,
        kind: 'service',
        url: mod.port ? `http://127.0.0.1:${mod.port}` : null,
      });
      return;
    }

    const wait = this.superviseService(mod, command);
    this.serviceWaits.push(wait);
    await this.waitUntilReady(mod);
    const record = {
      id: mod.id,
      kind: 'service',
      url: mod.port ? `http://127.0.0.1:${mod.port}` : null,
      live: !mod.port,
    };
    this.started.push(record);
    if (mod.port) {
      logger.ok(`${mod.id} http://127.0.0.1:${mod.port}`);
      waitForPort(mod.port).then((ok) => {
        record.live = ok;
        this.launcher?.update(this.started);
      });
    } else {
      logger.ok(`${mod.id} запущен`);
    }
  }

  async superviseService(mod, command) {
    let restarts = 0;
    while (!this.stopping) {
      const result = await this.spawnOnce(mod, command, { persist: true });
      if (this.stopping) {
        break;
      }
      const policy = this.options.noRestart ? 'never' : mod.restart;
      const shouldRestart =
        policy === 'always' || (policy === 'on-failure' && result.code !== 0);
      if (!shouldRestart) {
        if (result.code !== 0) {
          logger.error(`${mod.id} остановился с кодом ${result.code}`);
        } else {
          logger.ok(`${mod.id} завершился`);
        }
        break;
      }
      restarts += 1;
      if (restarts > mod.maxRestarts) {
        logger.error(`${mod.id}: превышен лимит перезапусков (${mod.maxRestarts})`);
        break;
      }
      logger.warn(`${mod.id}: перезапуск ${restarts}/${mod.maxRestarts} через ${mod.restartDelayMs}ms`);
      await sleep(mod.restartDelayMs);
    }
  }

  async prepareCommand(mod) {
    if (mod.kind !== 'static' && !mod.start) {
      throw new Error(`${mod.id}: не задан start и нет scripts.start / scripts.dev`);
    }

    const needsNpm = Boolean(mod.start && /\bnpm\b/.test(mod.start));
    const hasDeps = await pathExists(path.join(mod.absDir, 'node_modules'));

    if (this.options.skipInstall) {
      if (needsNpm && !hasDeps) {
        if (this.options.dryRun) {
          logger.warn(`${mod.id}: нет node_modules (dry-run)`);
          return mod.start;
        }
        throw new Error(
          `${mod.id}: модуль выкачан, но нет node_modules в ${mod.absDir}\n` +
            'Сначала поставьте зависимости: npm install',
        );
      }
      logger.pkg(mod.id, 'уже установлен, запускаю');
      return mod.start;
    }

    if (!mod.install || !mod.hasPackageJson || hasDeps) {
      logger.pkg(mod.id, hasDeps ? 'уже установлен, запускаю' : mod.start);
      return mod.start;
    }
    const install = boxInstallCommand(mod, this.box);
    logger.pkg(mod.id, install);
    if (this.options.dryRun) {
      return mod.start;
    }
    // dev-зависимости нужны для запуска, поэтому ставим не в prod-режиме (см. install-box.js)
    const env = {
      ...(await this.moduleEnv(mod)),
      NODE_ENV: 'development',
    };
    const result = await spawnCommand(install, { cwd: mod.absDir, env }).done;
    if (result.code !== 0) {
      throw new Error(`${mod.id}: не удалось поставить зависимости`);
    }
    const nodeModules = path.join(mod.absDir, 'node_modules');
    if (!(await pathExists(nodeModules))) {
      throw new Error(`${mod.id}: npm install завершился, но нет ${nodeModules}`);
    }
    return mod.start;
  }

  async moduleEnv(mod) {
    const fromFile = await loadEnvFile(path.resolve(mod.absDir, mod.envFile || '.env'));
    return {
      ...this.box.env,
      ...fromFile,
      ...mod.env,
    };
  }

  async spawnOnce(mod, command, { persist }) {
    const env = await this.moduleEnv(mod);
    const logPath = path.join(this.box.logsDir, `${mod.id}.log`);
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    const stamp = () => new Date().toISOString();
    stream.write(`\n----- ${stamp()} ${command} -----\n`);

    const { done } = spawnCommand(command, {
      cwd: mod.absDir,
      env,
      onLine: (line) => {
        stream.write(`[${stamp()}] ${line}\n`);
        if (this.options.verbose) {
          logger.pkg(mod.id, line);
        }
      },
    });

    const result = await done;
    stream.end();
    if (!persist && result.code !== 0 && !this.options.verbose) {
      logger.error(`${mod.id} код ${result.code}, лог: ${logPath}`);
    }
    return result;
  }

  async waitUntilReady(mod) {
    if (this.options.dryRun) {
      return;
    }
    const ready = mod.ready;
    if (!ready) {
      if (mod.port) {
        await sleep(Number(mod.readyWaitMs || 800));
      }
      return;
    }
    if (ready.waitMs) {
      await sleep(Number(ready.waitMs));
      return;
    }
    if (ready.url) {
      const timeoutMs = Number(ready.timeoutMs || 60000);
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (this.stopping) {
          return;
        }
        try {
          const response = await fetch(ready.url);
          if (response.ok) {
            return;
          }
        } catch {
          // still booting
        }
        await sleep(Number(ready.intervalMs || 500));
      }
      throw new Error(`${mod.id}: не дождался ready ${ready.url}`);
    }
  }

  printReady() {
    const lines = [
      `${this.box.product} ${this.box.version}`,
      'коробка запущена',
      `корень: ${this.box.root}`,
    ];
    for (const item of this.started) {
      if (item.url) {
        lines.push(`${item.id}: ${item.url}`);
      } else {
        lines.push(`${item.id}: ${item.kind}`);
      }
    }
    lines.push('логи: ' + this.box.logsDir);
    if (this.box.ui?.enabled) {
      lines.push(`лаунчер: http://127.0.0.1:${this.box.ui.port} (${this.box.ui.mode})`);
    }
    lines.push('остановка: Ctrl+C');
    logger.banner(lines);
  }
}
