import fs from 'node:fs/promises';
import { pathExists } from './fs.js';

export async function loadEnvFile(filePath) {
  if (!filePath || !(await pathExists(filePath))) {
    return {};
  }

  const raw = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const cut = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eq = cut.indexOf('=');
    if (eq <= 0) {
      continue;
    }

    const key = cut.slice(0, eq).trim();
    let value = cut.slice(eq + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

export function formatEnvValue(value) {
  const text = value == null ? '' : String(value);
  if (text === '') {
    return '';
  }
  if (/^[\[{]/.test(text)) {
    return text;
  }
  if (!/[\s#'"$`\\]/.test(text)) {
    return text;
  }
  if (!text.includes("'")) {
    return `'${text}'`;
  }
  if (!text.includes('"')) {
    return `"${text}"`;
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export async function writeEnvFile(filePath, lines) {
  const body = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  await fs.writeFile(filePath, body, 'utf8');
}

export async function upsertEnvKey(filePath, key, value) {
  let raw = '';
  if (await pathExists(filePath)) {
    raw = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
  }
  const line = `${key}=${formatEnvValue(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  let next;
  if (pattern.test(raw)) {
    next = raw.replace(pattern, () => line);
  } else {
    next = `${raw.replace(/\s+$/, '')}\n${line}\n`;
  }
  if (!next.endsWith('\n')) {
    next += '\n';
  }
  await fs.writeFile(filePath, next, 'utf8');
}
