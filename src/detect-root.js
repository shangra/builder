import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathExists } from './fs.js';

const builderDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memoryFile = path.join(builderDir, '.builder-root');

export const ANALYTICS_MARKERS = [
  'sreda-pivot',
  'sreda-analytics-spreadsheet-frontend',
  'sreda-analytics-migrations',
  'frontend-cms',
  'frontend-flow',
  'frontend-mdm',
];

export async function scoreAnalyticsRoot(dir) {
  if (!(await pathExists(dir))) {
    return 0;
  }
  let score = 0;
  for (const marker of ANALYTICS_MARKERS) {
    if (await pathExists(path.join(dir, marker))) {
      score += 1;
    }
  }
  return score;
}

export function isAnalyticsRoot(score) {
  return score >= 2;
}

export async function rememberRoot(root) {
  await fs.writeFile(memoryFile, `${root}\n`, 'utf8');
}

export async function readRememberedRoot() {
  if (!(await pathExists(memoryFile))) {
    return null;
  }
  const raw = (await fs.readFile(memoryFile, 'utf8')).replace(/^\uFEFF/, '').trim();
  return raw || null;
}

export async function detectAnalyticsRoot({
  explicit,
  configuredRoot,
  cwd = process.cwd(),
} = {}) {
  if (explicit) {
    const root = path.resolve(explicit);
    if (!(await pathExists(root))) {
      throw new Error(`Корень проекта не найден: ${root}`);
    }
    await rememberRoot(root);
    return { root, source: '--root / ANALYTICS_ROOT', score: await scoreAnalyticsRoot(root) };
  }

  const remembered = await readRememberedRoot();
  const candidates = [];

  const add = (dir, source) => {
    if (!dir) {
      return;
    }
    const resolved = path.resolve(dir);
    if (candidates.some((item) => item.path === resolved)) {
      return;
    }
    candidates.push({ path: resolved, source });
  };

  add(remembered, 'сохранённый путь');
  add(configuredRoot, 'builder.config.json');
  add(cwd, 'текущая папка');
  add(builderDir, 'папка билдера');
  add(path.join(builderDir, '..'), 'родитель билдера');
  add(path.join(builderDir, '..', 'project'), 'соседний проект');
  add(path.join(cwd, 'project'), 'cwd/project');

  for (const dir of walkUp(cwd, 5)) {
    add(dir, 'родители cwd');
  }
  for (const dir of walkUp(builderDir, 5)) {
    add(dir, 'родители билдера');
  }

  const home = os.homedir();
  add(path.join(home, 'Desktop', 'project'), 'Desktop/project');
  add(path.join(home, 'Documents', 'project'), 'Documents/project');
  add(path.join(home, 'Desktop', 'PROJECT'), 'Desktop/PROJECT');

  for (const projectsRoot of [
    path.join(home, 'PhpstormProjects'),
    path.join(path.parse(home).root, 'Users', path.basename(home), 'PhpstormProjects'),
    'D:\\Users\\Katya\\PhpstormProjects',
    'C:\\Users\\Katya\\PhpstormProjects',
  ]) {
    add(projectsRoot, 'PhpstormProjects');
    if (await pathExists(projectsRoot)) {
      const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) {
          add(path.join(projectsRoot, entry.name), 'PhpstormProjects/*');
        }
      }
    }
  }

  const desktop = path.join(home, 'Desktop');
  if (await pathExists(desktop)) {
    const entries = await fs.readdir(desktop, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        add(path.join(desktop, entry.name), 'Desktop/*');
      }
    }
  }

  let best = null;
  for (const candidate of candidates) {
    const score = await scoreAnalyticsRoot(candidate.path);
    if (!isAnalyticsRoot(score)) {
      continue;
    }
    if (!best || score > best.score) {
      best = { root: candidate.path, source: candidate.source, score };
    }
  }

  if (!best) {
    return null;
  }

  await rememberRoot(best.root);
  return best;
}

function walkUp(from, maxLevels) {
  const dirs = [];
  let current = path.resolve(from);
  for (let i = 0; i < maxLevels; i += 1) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    dirs.push(parent);
    current = parent;
  }
  return dirs;
}
