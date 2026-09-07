import path from 'node:path';
import readline from 'node:readline/promises';
import { loadEnvFile, upsertEnvKey } from './env-file.js';
import { spawnCommand } from './exec.js';
import { pathExists } from './fs.js';
import { logger } from './logger.js';

export async function runMigrationsDb(box, modules, { dryRun = false } = {}) {
  const mod =
    modules.find((item) => item.id === 'migrations') ||
    modules.find((item) => item.kind === 'oneshot');

  if (!mod) {
    throw new Error('В box.config.json нет модуля migrations.');
  }
  if (!mod.exists) {
    throw new Error(`${mod.id}: каталог не найден: ${mod.absDir}`);
  }
  if (!mod.hasPackageJson) {
    throw new Error(`${mod.id}: нет package.json в ${mod.absDir}`);
  }

  const command = 'npm run db';
  logger.pkg(mod.id, dryRun ? `dry-run ${command}` : command);
  if (dryRun) {
    return { ok: true };
  }

  const fromFile = await loadEnvFile(path.join(mod.absDir, mod.envFile || '.env'));
  const env = {
    ...box.env,
    ...fromFile,
    NODE_ENV: 'development',
  };
  const result = await spawnCommand(command, {
    cwd: mod.absDir,
    env,
    onLine: (line) => logger.pkg(mod.id, line),
  }).done;
  if (result.code !== 0) {
    throw new Error(`${mod.id}: npm run db завершился с кодом ${result.code}`);
  }
  logger.ok(`${mod.id}: схема базы применена`);
  await askAndWritePivotLicense(modules);
  return { ok: true };
}

async function askAndWritePivotLicense(modules) {
  const pivot = modules.find((item) => item.id === 'pivot');
  if (!pivot?.exists) {
    logger.warn('модуль pivot не найден, LICENSE_KEY не записан');
    return;
  }
  const envPath = path.join(pivot.absDir, pivot.envFile || '.env');
  if (!(await pathExists(envPath))) {
    throw new Error(`Нет ${envPath}. Сначала выполните npm run env.`);
  }

  const key = await promptLicenseKey();
  if (!key) {
    logger.warn('ключ не введён, LICENSE_KEY не изменён');
    return;
  }

  await upsertEnvKey(envPath, 'LICENSE_KEY', key);
  logger.ok(`pivot: LICENSE_KEY записан`);
}

async function promptLicenseKey() {
  if (!process.stdin.isTTY) {
    logger.warn('нет интерактивной консоли, LICENSE_KEY не запрошен');
    return '';
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const value = await rl.question('введите лицензионный ключ: ');
    return value.trim();
  } finally {
    rl.close();
  }
}
