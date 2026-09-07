import path from 'node:path';
import { spawnCommand } from './exec.js';
import { pathExists } from './fs-utils.js';
import { logger } from './logger.js';

export function boxInstallCommand(mod, box) {
  const flags = mod.buildInstallFlags || box.buildInstallFlags || '';
  const extra = Array.isArray(flags) ? flags.filter(Boolean).join(' ') : String(flags).trim();
  const prefix = `--prefix "${mod.absDir}"`;
  return extra ? `npm i ${extra} ${prefix}` : `npm install ${prefix}`;
}

export async function installBox(box, modules, { dryRun = false } = {}) {
  for (const mod of modules) {
    if (!mod.exists) {
      logger.warn(`${mod.id}: нет каталога ${mod.absDir}, пропуск`);
      continue;
    }
    if (mod.kind === 'static') {
      logger.info(`${mod.id}: static, npm install не нужен`);
      continue;
    }
    if (!mod.hasPackageJson) {
      logger.warn(`${mod.id}: нет package.json в ${mod.absDir}, пропуск`);
    }
  }

  const targets = modules.filter((mod) => mod.exists && mod.hasPackageJson && mod.kind !== 'static');
  if (targets.length === 0) {
    logger.warn('нет модулей для установки зависимостей');
    return { ok: true };
  }

  logger.info(`ставлю зависимости в ${targets.length} модул(ях)`);

  // модули независимы — ставим параллельно, общее время = самой долгой установке
  await Promise.all(
    targets.map(async (mod) => {
      const command = boxInstallCommand(mod, box);
      logger.pkg(mod.id, dryRun ? `dry-run ${command}` : command);
      if (dryRun) {
        return;
      }

      // NODE_ENV=production заставил бы npm выставить --omit=dev и вырезать
      // зависимости, без которых dev-серверы (craco start) не стартуют
      const result = await spawnCommand(command, {
        cwd: mod.absDir,
        env: { NODE_ENV: 'development' },
        onLine: (line) => logger.pkg(mod.id, line),
      }).done;
      if (result.code !== 0) {
        throw new Error(`${mod.id}: установка зависимостей завершилась с кодом ${result.code}`);
      }
      const nodeModules = path.join(mod.absDir, 'node_modules');
      if (!(await pathExists(nodeModules))) {
        throw new Error(
          `${mod.id}: npm install завершился, но нет ${nodeModules}\n` +
            'Поставьте зависимости вручную в этой папке и повторите npm run list.',
        );
      }
      logger.ok(`${mod.id}: зависимости установлены`);
    }),
  );

  return { ok: true };
}
