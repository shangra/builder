import path from 'node:path';
import { loadBoxConfig, resolveBoxModules } from './box.config.js';
import { loadConfig, selectPackages } from './config.js';
import { writeGeneratedConfig } from './discover.js';
import { killChildren } from './exec.js';
import { pathExists } from './fs.js';
import { generateModuleEnvs } from './env-gen.js';
import { installBox } from './install-box.js';
import { runMigrationsDb } from './migrate.js';
import { logger } from './logger.js';
import { startLauncherServer } from './launcher-server.js';
import { printSummary, runBuild, writeReport } from './runner.js';
import { runBox } from './supervisor.js';

const VERSION = '1.0.0';

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    logger.raw(`${VERSION}\n`);
    return;
  }

  const runtimeCommands = new Set(['start', 'list', 'validate', 'install', 'ui', 'env', 'db']);
  if (runtimeCommands.has(args.command)) {
    await runRuntime(args);
    return;
  }

  process.on('SIGINT', () => {
    logger.warn('остановка, завершаю дочерние процессы...');
    killChildren();
    process.exit(130);
  });

  const config = await loadConfig({
    configPath: args.config,
    rootArg: args.root,
  });

  if (!(await pathExists(config.root))) {
    throw new Error(`Корень проекта не найден: ${config.root}\nукажите --root или BOX_ROOT`);
  }

  logger.info(`корень: ${config.root} (${config.rootSource})`);

  if (args.command === 'init') {
    const outputPath = path.resolve(args.out || path.join(config.root, 'box.config.json'));
    const result = await writeGeneratedConfig(config.root, outputPath, config.skipDirs);
    logger.ok(`конфиг записан: ${result.outputPath}`);
    logger.info(`пакетов найдено: ${result.packages.length}`);
    for (const pkg of result.packages) {
      logger.pkg(pkg.id, `${pkg.dir} [${pkg.group}]`);
    }
    return;
  }

  const profile = args.profile || config.defaultProfile;
  const { selected } = await selectPackages(config, {
    profile,
    only: args.only,
    skip: args.skip,
  });

  if (selected.length === 0) {
    throw new Error('Нет пакетов для сборки. Проверьте --root, --only и профиль.');
  }

  const outputDir = path.resolve(config.root, args.output || config.outputDir);
  const concurrency = Math.max(1, Number(args.concurrency || config.concurrency || 3));

  logger.banner([
    `sreda-builder ${VERSION}`,
    `проект: ${config.name}`,
    `корень: ${config.root}`,
    `профиль: ${profile}`,
    `пакеты: ${selected.map((pkg) => pkg.id).join(', ')}`,
    `потоки: ${concurrency}${args.dryRun ? ' | dry-run' : ''}`,
  ]);

  const report = await runBuild(selected, {
    concurrency,
    dryRun: args.dryRun,
    keepGoing: args.keepGoing,
    skipInstall: args.skipInstall,
    installOnly: args.installOnly,
    verbose: args.verbose,
    outputDir,
    installFlags: config.buildInstallFlags,
  });

  printSummary(report);

  const reportPath = args.report || path.join(config.root, '.builder-report.json');
  await writeReport(reportPath, {
    name: config.name,
    root: config.root,
    profile,
    outputDir,
    generatedAt: new Date().toISOString(),
    ...report,
  });
  logger.info(`отчёт: ${reportPath}`);

  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function runRuntime(args) {
  const box = await loadBoxConfig({
    configPath: args.config,
    rootArg: args.root,
  });
  const { selected, all } = await resolveBoxModules(box, {
    only: args.only,
    skip: args.skip,
  });

  logger.info(`коробка: ${box.product} - ${box.configPath}`);
  logger.info(`корень: ${box.root}`);

  if (args.uiMode) {
    box.ui.mode = args.uiMode;
  }

  if (args.command === 'list' || args.command === 'validate') {
    printBoxList(box, selected, all, args.command === 'validate');
    if (args.command === 'validate') {
      const blocking = selected.filter((mod) => !mod.optional && !mod.exists);
      if (blocking.length > 0) {
        process.exitCode = 1;
      }
    }
    return;
  }

  if (args.command === 'ui') {
    const started = box.modules
      .filter((mod) => mod.enabled && mod.port)
      .map((mod) => ({
        id: mod.id,
        kind: 'service',
        url: `http://127.0.0.1:${mod.port}`,
      }));
    const launcher = await startLauncherServer(box, started, {
      open: args.noOpen !== true,
    });
    if (!launcher) {
      throw new Error('Лаунчер выключен в box.config.json (ui.enabled: false).');
    }
    logger.info('оболочка запущена. Остановка — Ctrl+C');
    await new Promise(() => {});
    return;
  }

  if (selected.length === 0) {
    throw new Error('Нет включённых модулей. Проверьте box.config.json, --only и --skip.');
  }

  if (args.command === 'install') {
    for (const mod of selected.filter((item) => !item.exists)) {
      logger.warn(`${mod.id}: нет каталога ${mod.absDir}, пропуск`);
    }
    await installBox(box, selected, { dryRun: args.dryRun });
    logger.ok('Зависимости установлены. Запуск: npm start');
    return;
  }

  if (args.command === 'env') {
    const result = await generateModuleEnvs(box, selected, {
      envFile: args.envFile,
      dryRun: args.dryRun,
    });
    logger.ok(`готово: ${result.written.length} файл(ов) из ${result.globalPath}`);
    return;
  }

  if (args.command === 'db') {
    await runMigrationsDb(box, all, { dryRun: args.dryRun });
    return;
  }

  const missing = selected.filter((mod) => !mod.exists && !mod.optional);
  if (missing.length > 0) {
    const lines = missing.map((mod) => `  ${mod.id}: ${mod.absDir}`).join('\n');
    throw new Error(
      `Не найдены модули коробки:\n${lines}\nУкажите --root (каталог, где лежат эти папки) или поправьте path в box.config.json.`,
    );
  }

  const result = await runBox(box, selected, {
    dryRun: args.dryRun,
    skipInstall: !args.doInstall,
    verbose: args.verbose,
    noRestart: args.noRestart,
    openUi: args.noOpen !== true,
    installFlags: box.buildInstallFlags,
  });

  if (result.interrupted) {
    process.exitCode = 130;
    return;
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function printBoxList(box, selected, all, validate) {
  logger.banner([
    `продукт: ${box.product} ${box.version}`,
    `корень: ${box.root}`,
    `конфиг: ${box.configPath}`,
  ]);

  for (const mod of all) {
    const inRun = selected.some((item) => item.id === mod.id);
    const state = !mod.enabled
      ? 'выключен'
      : !mod.exists
        ? 'нет каталога'
        : `${mod.kind}${mod.start ? ` · ${mod.start}` : ''}${mod.port ? ` :${mod.port}` : ''}${
            mod.hasNodeModules ? ' · deps ok' : ' · нет node_modules'
          }`;
    const mark = inRun ? '*' : ' ';
    logger.pkg(mod.id, `${mark} ${mod.path} ${state}${mod.optional ? ' optional' : ''}`);
    if (validate && inRun) {
      logger.pkg(mod.id, `    ${mod.absDir}`);
    }
  }
}

function parseArgs(argv) {
  const args = {
    command: 'start',
    only: [],
    skip: [],
    help: false,
    version: false,
    dryRun: false,
    keepGoing: false,
    skipInstall: false,
    installOnly: false,
    verbose: false,
    noRestart: false,
    doInstall: false,
    noOpen: false,
    uiMode: null,
    envFile: null,
  };

  const commands = new Set(['build', 'init', 'list', 'validate', 'start', 'install', 'ui', 'env', 'db']);
  const tokens = [...argv];

  if (tokens[0] && !tokens[0].startsWith('-') && commands.has(tokens[0])) {
    args.command = tokens.shift();
  }

  while (tokens.length > 0) {
    const token = tokens.shift();
    switch (token) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      case '--root':
        args.root = needValue(token, tokens);
        break;
      case '--config':
        args.config = needValue(token, tokens);
        break;
      case '--env-file':
        args.envFile = needValue(token, tokens);
        break;
      case '--profile':
        args.profile = needValue(token, tokens);
        break;
      case '--only':
        args.only = splitList(needValue(token, tokens));
        break;
      case '--skip':
        args.skip = splitList(needValue(token, tokens));
        break;
      case '--concurrency':
        args.concurrency = needValue(token, tokens);
        break;
      case '--output':
        args.output = needValue(token, tokens);
        break;
      case '--out':
        args.out = needValue(token, tokens);
        break;
      case '--report':
        args.report = needValue(token, tokens);
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--keep-going':
        args.keepGoing = true;
        break;
      case '--no-install':
        args.skipInstall = true;
        args.doInstall = false;
        break;
      case '--install':
        args.doInstall = true;
        break;
      case '--install-only':
        args.installOnly = true;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--no-restart':
        args.noRestart = true;
        break;
      case '--no-open':
        args.noOpen = true;
        break;
      case '--ui':
        args.uiMode = needValue(token, tokens);
        if (args.uiMode !== 'launcher' && args.uiMode !== 'browser') {
          throw new Error('--ui: ожидается launcher или browser');
        }
        break;
      default:
        throw new Error(`Неизвестный аргумент: ${token}\nЗапустите с --help`);
    }
  }

  return args;
}

function needValue(flag, tokens) {
  const value = tokens.shift();
  if (!value || value.startsWith('-')) {
    throw new Error(`Флаг ${flag} требует значение`);
  }
  return value;
}

function splitList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function printHelp() {
  logger.raw(`
sreda-builder ${VERSION}
Коробочный запуск и сборка аналитики.

Использование:
  npm start
  npm run env
  npm run db
  npm install

Команды:
  start       Запустить коробку (pivot, аналитика, админка)
  ui          Только оболочка лаунчера (переходы аналитика / админка)
  install     Поставить зависимости во все модули
  env         Сгенерировать .env модулей из глобального .env
  db          Применить миграции (npm run db в модуле migrations)
  list        Показать состав коробки
  validate    Проверить, что пути модулей существуют
  build       Собрать пакеты
  init        Сгенерировать конфиг по каталогам

Состав коробки задаётся в box.config.json: добавьте или выключите модуль (enabled: false).

Опции:
  --root <путь>           Корень коробки с модулями
  --config <файл>         Путь к box.config.json
  --env-file <файл>       Глобальный .env (по умолчанию рядом с box.config.json)
  --only <id,id>          Только эти модули
  --skip <id,id>          Исключить модули
  --dry-run               Показать план, не запускать
  --install               Перед стартом поставить недостающие зависимости
  --no-restart            Не перезапускать упавшие сервисы
  --verbose               Поток логов модулей в консоль
  --profile <имя>         Профиль сборки (только build)
  --ui <launcher|browser> Где открывать приложения
  --no-open               Не открывать браузер / оболочку
  -h, --help              Справка

Примеры:
  npm install
  npm run env
  npm run db
  npm start
  npm start -- --only pivot,spreadsheet
`.trimStart());
}
