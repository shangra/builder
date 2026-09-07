import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAnalyticsRoot, scoreAnalyticsRoot, isAnalyticsRoot } from './detect-root.js';
import { discoverPackages, inferStart, inferSteps } from './discover.js';
import { pathExists, readJson } from './fs-utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledConfigPath = path.resolve(here, '..', 'builder.config.json');

export async function loadConfig({ configPath, rootArg } = {}) {
  const resolvedConfigPath = await resolveConfigPath(configPath);
  const fileConfig = resolvedConfigPath ? await readJson(resolvedConfigPath) : {};
  const configDir = resolvedConfigPath ? path.dirname(resolvedConfigPath) : process.cwd();
  const configuredRoot = fileConfig.root ? path.resolve(configDir, fileConfig.root) : null;
  const configuredLooksLikeProject =
    configuredRoot && isAnalyticsRoot(await scoreAnalyticsRoot(configuredRoot));

  const detected = await detectAnalyticsRoot({
    explicit: rootArg || process.env.ANALYTICS_ROOT,
    configuredRoot: configuredLooksLikeProject ? configuredRoot : null,
    cwd: process.cwd(),
  });

  if (!detected) {
    throw new Error(
      'Не нашёл корень аналитики (нужны папки вроде sreda-pivot, frontend-cms).\n' +
        'Запустите npm start из корня проекта, укажите --root или задайте ANALYTICS_ROOT.',
    );
  }

  const root = detected.root;

  const config = {
    name: fileConfig.name || path.basename(root),
    root,
    rootSource: detected.source,
    outputDir: fileConfig.outputDir || 'dist-release',
    concurrency: Number(fileConfig.concurrency || '3'),
    defaultProfile: fileConfig.defaultProfile || 'full',
    profiles: fileConfig.profiles || {},
    skipDirs: new Set(fileConfig.skipDirs || ['node_modules', '.git']),
    configPath: resolvedConfigPath,
    packages: fileConfig.packages || [],
    buildInstallFlags: fileConfig.buildInstallFlags || null,
  };

  if (config.packages.length === 0) {
    config.packages = await discoverPackages(root, config.skipDirs);
  }

  return config;
}

async function resolveConfigPath(configPath) {
  if (configPath) {
    const absolute = path.resolve(configPath);
    if (!(await pathExists(absolute))) {
      throw new Error(`Конфиг не найден: ${absolute}`);
    }
    return absolute;
  }

  const fromCwd = path.resolve(process.cwd(), 'builder.config.json');
  if (await pathExists(fromCwd)) {
    return fromCwd;
  }

  if (await pathExists(bundledConfigPath)) {
    return bundledConfigPath;
  }

  return null;
}

export function normalizeStep(step) {
  if (typeof step === 'string') {
    return { run: step, when: null };
  }
  return {
    run: step.run,
    when: Array.isArray(step.when) ? step.when : step.when ? [step.when] : null,
  };
}

export function stepMatchesProfile(step, profile) {
  const normalized = normalizeStep(step);
  if (!normalized.when || normalized.when.length === 0) {
    return true;
  }
  return normalized.when.includes(profile);
}

export async function resolvePackage(pkg, root, profile, configBuildInstallFlags) {
  const dir = path.resolve(root, pkg.dir);
  const packageJsonPath = path.join(dir, 'package.json');
  const exists = await pathExists(dir);
  const hasPackageJson = exists && (await pathExists(packageJsonPath));
  const packageJson = hasPackageJson ? await readJson(packageJsonPath) : null;
  const configuredSteps = pkg.steps?.length
    ? pkg.steps
    : inferSteps(packageJson?.scripts || {});
  const steps = configuredSteps
    .filter((step) => stepMatchesProfile(step, profile))
    .map(normalizeStep)
    .filter((step) => Boolean(step.run));

  return {
    id: pkg.id || pkg.dir,
    dir: pkg.dir,
    absDir: dir,
    group: pkg.group || 'other',
    optional: Boolean(pkg.optional),
    enabled: pkg.enabled !== false,
    dependsOn: pkg.dependsOn || [],
    artifacts: pkg.artifacts || [],
    env: pkg.env || {},
    skipInstall: Boolean(pkg.skipInstall),
    buildInstallFlags: pkg.buildInstallFlags || configBuildInstallFlags || null,
    start: pkg.start || inferStart(pkg.dir, packageJson?.scripts || {}),
    exists,
    hasPackageJson,
    packageJson,
    steps,
  };
}

export async function selectPackages(config, { profile, only, skip }) {
  const resolved = [];
  for (const pkg of config.packages) {
    resolved.push(await resolvePackage(pkg, config.root, profile, config.buildInstallFlags));
  }

  const profileGroups = config.profiles?.[profile]?.groups;
  let selected = resolved.filter((pkg) => pkg.enabled);

  if (Array.isArray(profileGroups) && profileGroups.length > 0) {
    selected = selected.filter((pkg) => profileGroups.includes(pkg.group));
  }

  if (only.length > 0) {
    selected = selected.filter((pkg) => only.includes(pkg.id) || only.includes(pkg.dir));
  }

  if (skip.length > 0) {
    selected = selected.filter((pkg) => !skip.includes(pkg.id) && !skip.includes(pkg.dir));
  }

  return { all: resolved, selected };
}
