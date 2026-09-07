import fs from 'node:fs/promises';
import path from 'node:path';
import { assembleArtifacts } from './assemble.js';
import { runCommand } from './exec.js';
import { pathExists } from './fs.js';
import { formatDuration, logger } from './logger.js';

export async function installCommandFor(dir, extraFlags) {
  const flags = extraFlags || process.env.BUILD_INSTALL_FLAGS || '';
  const extra = Array.isArray(flags) ? flags.filter(Boolean).join(' ') : String(flags).trim();
  const suffix = extra ? ` ${extra}` : '';

  if (await pathExists(path.join(dir, 'package-lock.json'))) {
    return `npm ci --no-audit --no-fund --ignore-scripts${suffix}`;
  }
  if (await pathExists(path.join(dir, 'npm-shrinkwrap.json'))) {
    return `npm ci --no-audit --no-fund --ignore-scripts${suffix}`;
  }
  return `npm install --no-audit --no-fund --ignore-scripts${suffix}`;
}

function npmScriptName(command) {
  const match = command.trim().match(/^npm\s+run\s+([^\s]+)/);
  return match ? match[1] : null;
}

function hasNpmScript(pkg, command) {
  const script = npmScriptName(command);
  if (!script) {
    return true;
  }
  return Boolean(pkg.packageJson?.scripts?.[script]);
}

function topoSchedule(packages) {
  const selectedIds = new Set(packages.map((pkg) => pkg.id));
  for (const pkg of packages) {
    pkg.dependsOn = (pkg.dependsOn || []).filter((dep) => selectedIds.has(dep));
  }
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  return { byId, remaining: new Set(packages.map((pkg) => pkg.id)) };
}

export async function runBuild(packages, options) {
  const {
    concurrency,
    dryRun,
    keepGoing,
    skipInstall,
    installOnly,
    verbose,
    outputDir,
  } = options;

  const results = [];
  const { byId, remaining } = topoSchedule(packages);
  const inFlight = new Map();
  const succeeded = new Set();
  const failed = new Set();
  const startedAt = Date.now();

  const startNext = () => {
    const ready = [...remaining]
      .map((id) => byId.get(id))
      .filter((pkg) => (pkg.dependsOn || []).every((dep) => succeeded.has(dep) || failed.has(dep)));

    for (const pkg of ready) {
      if (inFlight.size >= concurrency) {
        break;
      }
      if ((pkg.dependsOn || []).some((dep) => failed.has(dep))) {
        remaining.delete(pkg.id);
        failed.add(pkg.id);
        const result = {
          id: pkg.id,
          dir: pkg.dir,
          absDir: pkg.absDir,
          artifacts: pkg.artifacts,
          status: 'skipped',
          reason: 'зависимость не собралась',
          ok: false,
          durationMs: 0,
        };
        results.push(result);
        logger.warn(`${pkg.id}: пропущен, не собралась зависимость`);
        continue;
      }

      remaining.delete(pkg.id);
      const job = buildPackage(pkg, { dryRun, skipInstall, installOnly, verbose }).then((result) => {
        inFlight.delete(pkg.id);
        results.push(result);
        if (result.ok) {
          succeeded.add(pkg.id);
        } else {
          failed.add(pkg.id);
        }
        return result;
      });
      inFlight.set(pkg.id, job);
    }
  };

  while (remaining.size > 0 || inFlight.size > 0) {
    startNext();

    if (inFlight.size === 0 && remaining.size > 0) {
      const leftover = [...remaining].join(', ');
      throw new Error(`Циклическая зависимость или неразрешённые пакеты: ${leftover}`);
    }

    if (inFlight.size === 0) {
      break;
    }

    const finished = await Promise.race(inFlight.values());
    if (!finished.ok && !keepGoing) {
      await Promise.allSettled([...inFlight.values()]);
      break;
    }
  }

  const okResults = results.filter((item) => item.ok);
  const assemble = !installOnly
    ? await assembleArtifacts(okResults, outputDir, { dryRun })
    : { copied: [], missing: [] };

  return {
    results,
    assemble,
    durationMs: Date.now() - startedAt,
    ok: results.every((item) => item.ok),
  };
}

async function buildPackage(pkg, { dryRun, skipInstall, installOnly, verbose }) {
  const startedAt = Date.now();
  logger.info(`${pkg.id} -> ${pkg.absDir}`);

  if (!pkg.exists) {
    if (pkg.optional) {
      logger.warn(`${pkg.id}: каталог не найден, пакет optional - пропуск`);
      return {
        ...baseResult(pkg, startedAt),
        status: 'skipped',
        reason: 'каталог не найден',
        ok: true,
      };
    }
    logger.error(`${pkg.id}: каталог не найден`);
    return {
      ...baseResult(pkg, startedAt),
      status: 'missing',
      reason: 'каталог не найден',
      ok: false,
    };
  }

  if (!pkg.hasPackageJson) {
    if (pkg.optional) {
      logger.warn(`${pkg.id}: нет package.json, пропуск`);
      return {
        ...baseResult(pkg, startedAt),
        status: 'skipped',
        reason: 'нет package.json',
        ok: true,
      };
    }
    logger.error(`${pkg.id}: нет package.json`);
    return {
      ...baseResult(pkg, startedAt),
      status: 'missing',
      reason: 'нет package.json',
      ok: false,
    };
  }

  if (!installOnly && pkg.steps.length === 0 && !pkg.optional) {
    logger.error(`${pkg.id}: нет шагов сборки (проверьте scripts в package.json)`);
    return {
      ...baseResult(pkg, startedAt),
      status: 'failed',
      reason: 'нет шагов',
      ok: false,
    };
  }

  const commands = [];
  if (!skipInstall && !pkg.skipInstall) {
    commands.push(await installCommandFor(pkg.absDir, pkg.buildInstallFlags));
  }
  if (!installOnly) {
    for (const step of pkg.steps) {
      if (!hasNpmScript(pkg, step.run)) {
        if (pkg.optional) {
          logger.warn(`${pkg.id}: нет скрипта для "${step.run}", пропуск шага`);
          continue;
        }
        logger.error(`${pkg.id}: в package.json нет скрипта для "${step.run}"`);
        return {
          ...baseResult(pkg, startedAt),
          status: 'failed',
          reason: `нет скрипта: ${step.run}`,
          ok: false,
        };
      }
      commands.push(step.run);
    }
  }

  if (commands.length === 0) {
    logger.warn(`${pkg.id}: нечего запускать`);
    return {
      ...baseResult(pkg, startedAt),
      status: 'skipped',
      reason: 'нет шагов',
      ok: true,
    };
  }

  for (const command of commands) {
    logger.pkg(pkg.id, dryRun ? `dry-run ${command}` : command);
    const result = await runCommand(command, {
      cwd: pkg.absDir,
      env: pkg.env,
      dryRun,
      onLine: verbose
        ? (line) => logger.pkg(pkg.id, line)
        : undefined,
    });

    if (result.code !== 0) {
      if (!verbose) {
        const combined = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
        const tail = combined.split(/\r?\n/).slice(-20).join('\n');
        if (tail) {
          logger.error(`${pkg.id} вывод:\n${tail}`);
        }
      }
      logger.error(`${pkg.id}: команда завершилась с кодом ${result.code}: ${command}`);
      return {
        ...baseResult(pkg, startedAt),
        status: 'failed',
        reason: command,
        ok: false,
      };
    }
  }

  logger.ok(`${pkg.id} за ${formatDuration(Date.now() - startedAt)}`);
  return {
    ...baseResult(pkg, startedAt),
    status: 'ok',
    ok: true,
  };
}

function baseResult(pkg, startedAt) {
  return {
    id: pkg.id,
    dir: pkg.dir,
    absDir: pkg.absDir,
    artifacts: pkg.artifacts,
    durationMs: Date.now() - startedAt,
  };
}

export async function writeReport(filePath, report) {
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function printSummary(report) {
  logger.banner([
    `итог: ${report.ok ? 'успех' : 'есть ошибки'}`,
    `время: ${formatDuration(report.durationMs)}`,
    `пакетов: ${report.results.length}`,
  ]);

  for (const item of report.results) {
    const mark = item.ok ? 'ok' : item.status === 'skipped' ? 'skip' : 'fail';
    const extra = item.reason ? ` (${item.reason})` : '';
    const line = `${item.id.padEnd(24, ' ')} ${mark.padEnd(4, ' ')} ${formatDuration(item.durationMs)}${extra}`;
    if (item.ok) {
      logger.ok(line);
    } else if (item.status === 'skipped') {
      logger.warn(line);
    } else {
      logger.error(line);
    }
  }

  if (report.assemble.copied.length > 0) {
    logger.info(`артефакты: ${report.assemble.copied.length} скопировано`);
  }
  for (const miss of report.assemble.missing) {
    logger.warn(`${miss.id}: не найдены артефакты ${miss.artifacts.join(', ')}`);
  }
}
