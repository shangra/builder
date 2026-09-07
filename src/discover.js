import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists, readJson } from './fs.js';

const DEFAULT_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'dist-release',
  'loc-files',
  'coverage',
]);

export function inferGroup(dirName, scripts = {}) {
  if (dirName.startsWith('frontend') || dirName.includes('spreadsheet-frontend')) {
    return 'frontend';
  }
  if (scripts['build:bundle'] || scripts['build:binary'] || dirName.includes('pivot')) {
    return 'backend';
  }
  if (dirName.includes('migration')) {
    return 'backend';
  }
  return 'other';
}

export function inferArtifacts(dirName, scripts = {}) {
  if (scripts.build?.includes('BUILD_PATH=')) {
    const match = scripts.build.match(/BUILD_PATH=([^\s]+)/);
    if (match) {
      return [match[1]];
    }
  }
  if (dirName.includes('spreadsheet-frontend')) {
    return ['bi_ui_build'];
  }
  if (scripts['build:binary'] || scripts['build:bundle']) {
    return ['dist'];
  }
  return ['build', 'dist'];
}

export function inferStart(dirName, scripts = {}) {
  if (dirName.includes('migration') || dirName.endsWith('.mo')) {
    return null;
  }
  if (scripts.dev && (dirName.includes('pivot') || scripts['build:bundle'])) {
    return 'npm run dev';
  }
  if (scripts.start) {
    return 'npm start';
  }
  if (scripts.dev) {
    return 'npm run dev';
  }
  return null;
}

export function inferSteps(scripts = {}) {
  if (scripts['build:bundle']) {
    const steps = [];
    if (scripts['core:collect']) {
      steps.push('npm run core:collect');
    }
    steps.push('npm run build:bundle');
    if (scripts['build:obfuscate']) {
      steps.push({ run: 'npm run build:obfuscate', when: ['release'] });
    }
    if (scripts['build:binary']) {
      steps.push({ run: 'npm run build:binary', when: ['release'] });
    }
    return steps;
  }
  if (scripts.build) {
    return ['npm run build'];
  }
  if (scripts['build:local']) {
    return ['npm run build:local'];
  }
  return [];
}

export async function discoverPackages(root, skipDirs = DEFAULT_SKIP) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (skipDirs.has(entry.name) || entry.name.startsWith('.')) {
      continue;
    }
    if (entry.name.endsWith('.mo')) {
      continue;
    }

    const dir = path.join(root, entry.name);
    const packageJsonPath = path.join(dir, 'package.json');
    if (!(await pathExists(packageJsonPath))) {
      continue;
    }

    const packageJson = await readJson(packageJsonPath);
    const scripts = packageJson.scripts || {};

    packages.push({
      id: packageJson.name || entry.name,
      dir: entry.name,
      group: inferGroup(entry.name, scripts),
      enabled: entry.name !== 'old-analytic',
      steps: inferSteps(scripts),
      start: inferStart(entry.name, scripts),
      artifacts: inferArtifacts(entry.name, scripts),
    });
  }

  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

export async function writeGeneratedConfig(root, outputPath, skipDirs) {
  const packages = await discoverPackages(root, skipDirs);
  const config = {
    name: path.basename(root),
    root: '.',
    outputDir: 'dist-release',
    concurrency: 3,
    defaultProfile: 'full',
    profiles: {
      full: { description: 'Сборка всех включённых пакетов' },
      frontend: { groups: ['frontend'] },
      backend: { groups: ['backend'] },
      release: { description: 'Полная сборка, включая обфускацию и бинарник' },
    },
    skipDirs: [...skipDirs],
    packages,
  };

  await fs.writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { outputPath, packages };
}
