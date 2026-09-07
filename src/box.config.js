import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferStart } from './discover.js';
import { pathExists, readJson } from './fs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const builderDir = path.resolve(here, '..');

export async function loadBoxConfig({ configPath, rootArg } = {}) {
  const resolvedConfigPath = await resolveBoxConfigPath(configPath, rootArg);
  if (!resolvedConfigPath) {
    throw new Error(
      'Не найден box.config.json.\nПоложите конфиг в корень коробки или укажите --config / --root.',
    );
  }

  const fileConfig = await readJson(resolvedConfigPath);
  const configDir = path.dirname(resolvedConfigPath);
  const root = path.resolve(
    rootArg || process.env.BOX_ROOT || path.resolve(configDir, fileConfig.root || '.'),
  );

  const modules = (fileConfig.modules || fileConfig.packages || []).map((item) =>
    normalizeModule(item),
  );

  if (modules.length === 0) {
    throw new Error(`В ${resolvedConfigPath} нет modules. Добавьте модули коробки.`);
  }

  return {
    product: fileConfig.product || fileConfig.name || path.basename(root),
    version: fileConfig.version || '1.0.0',
    root,
    logsDir: path.resolve(root, fileConfig.logsDir || 'logs'),
    clearLogs: Boolean(fileConfig.clearLogs),
    env: fileConfig.env || {},
    buildInstallFlags: fileConfig.buildInstallFlags || null,
    ui: normalizeUi(fileConfig.ui),
    fastStart: fileConfig.fastStart !== false,
    preferStatic: fileConfig.preferStatic !== false,
    configPath: resolvedConfigPath,
    modules,
  };
}

async function resolveBoxConfigPath(configPath, rootArg) {
  if (configPath) {
    const absolute = path.resolve(configPath);
    if (!(await pathExists(absolute))) {
      throw new Error(`Конфиг не найден: ${absolute}`);
    }
    return absolute;
  }

  const names = ['box.config.json', 'builder.config.json'];
  const dirs = [
    rootArg ? path.resolve(rootArg) : null,
    process.cwd(),
    builderDir,
    process.env.BOX_ROOT ? path.resolve(process.env.BOX_ROOT) : null,
  ].filter(Boolean);

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await pathExists(candidate)) {
        const parsed = await readJson(candidate);
        if (name === 'builder.config.json' && !parsed.modules && !parsed.packages) {
          continue;
        }
        return candidate;
      }
    }
  }

  return null;
}

function normalizeModule(item) {
  const id = item.id || item.name;
  const modulePath = item.path || item.dir;
  if (!id || !modulePath) {
    throw new Error('У каждого модуля нужны id и path');
  }
  return {
    id,
    path: modulePath,
    kind: item.kind || 'service',
    start: item.start || null,
    dist: item.dist || null,
    host: item.host || '0.0.0.0',
    port: item.port || null,
    spa: item.spa !== false,
    dependsOn: item.dependsOn || [],
    restart: item.restart || (item.kind === 'oneshot' ? 'never' : 'on-failure'),
    restartDelayMs: Number(item.restartDelayMs || 2000),
    maxRestarts: Number(item.maxRestarts || 10),
    optional: Boolean(item.optional),
    enabled: item.enabled !== false,
    env: item.env || {},
    envFile: item.envFile || '.env',
    install: item.install !== false,
    buildInstallFlags: item.buildInstallFlags || null,
    ready: item.ready || null,
  };
}

function normalizeUi(ui = {}) {
  const apps = Array.isArray(ui.apps) && ui.apps.length > 0
    ? ui.apps
    : [
        {
          id: 'analytics',
          title: 'Аналитика',
          subtitle: 'Отчёты и таблицы',
          module: 'spreadsheet',
        },
        {
          id: 'admin',
          title: 'Админка',
          subtitle: 'Управление системой',
          module: 'admin',
        },
      ];

  return {
    enabled: ui.enabled !== false,
    mode: ui.mode === 'browser' ? 'browser' : 'launcher',
    port: Number(ui.port || 9090),
    host: ui.host || '127.0.0.1',
    openOnStart: ui.openOnStart !== false,
    apps: apps.map((app, index) => ({
      id: app.id || app.module || `app-${index}`,
      title: app.title || app.id || app.module,
      subtitle: app.subtitle || '',
      module: app.module,
      url: app.url || null,
    })),
  };
}

export async function resolveBoxModules(box, { only = [], skip = [] } = {}) {
  const resolved = [];
  for (const mod of box.modules) {
    const absDir = path.resolve(box.root, mod.path);
    const packageJsonPath = path.join(absDir, 'package.json');
    const exists = await pathExists(absDir);
    const hasPackageJson = exists && (await pathExists(packageJsonPath));
    const packageJson = hasPackageJson ? await readJson(packageJsonPath) : null;
    const start =
      mod.start ||
      inferStart(path.basename(absDir), packageJson?.scripts || {}) ||
      (packageJson?.scripts?.start ? 'npm start' : null);

    const hasNodeModules = exists && (await pathExists(path.join(absDir, 'node_modules')));

    resolved.push({
      ...mod,
      absDir,
      exists,
      hasPackageJson,
      hasNodeModules,
      packageJson,
      start,
      distDir: mod.dist ? path.resolve(absDir, mod.dist) : null,
    });
  }

  let selected = resolved.filter((mod) => mod.enabled);
  if (only.length > 0) {
    selected = selected.filter((mod) => only.includes(mod.id) || only.includes(path.basename(mod.path)));
  }
  if (skip.length > 0) {
    selected = selected.filter((mod) => !skip.includes(mod.id) && !skip.includes(path.basename(mod.path)));
  }
  return { all: resolved, selected };
}

export function orderModules(modules) {
  const byId = new Map(modules.map((mod) => [mod.id, mod]));
  const selectedIds = new Set(modules.map((mod) => mod.id));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  const visit = (id, stack) => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`Циклическая зависимость: ${[...stack, id].join(' -> ')}`);
    }
    visiting.add(id);
    const mod = byId.get(id);
    for (const dep of mod.dependsOn || []) {
      if (!selectedIds.has(dep)) {
        continue;
      }
      visit(dep, [...stack, id]);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(mod);
  };

  for (const mod of modules) {
    visit(mod.id, []);
  }
  return ordered;
}
