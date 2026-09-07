import path from 'node:path';
import { formatEnvValue, loadEnvFile, writeEnvFile } from './env-file.js';
import { pathExists } from './fs-utils.js';
import { logger } from './logger.js';

const HEADER = '# ВНИМАНИЕ!!! Этот файл сгенерирован автоматически и может быть перезаписан!';

const TEMPLATES = {
  pivot: renderPivot,
  migrations: renderMigrations,
  spreadsheet: renderSpreadsheet,
  admin: renderAdmin,
};

export async function generateModuleEnvs(box, modules, { envFile, dryRun = false } = {}) {
  const globalPath = envFile || path.join(path.dirname(box.configPath), '.env');
  if (!(await pathExists(globalPath))) {
    throw new Error(
      `Нет глобального .env: ${globalPath}\n` +
        'Скопируйте .env.example в .env и заполните значения.',
    );
  }

  const env = await loadEnvFile(globalPath);
  const ctx = buildContext(env, box, modules);
  if (ctx.missing.length > 0) {
    throw new Error(`В глобальном .env не заполнены поля: ${ctx.missing.join(', ')}`);
  }

  const written = [];
  for (const mod of modules) {
    const render = TEMPLATES[mod.id];
    if (!render) {
      logger.warn(`${mod.id}: нет шаблона .env, пропуск`);
      continue;
    }
    if (!mod.exists) {
      logger.warn(`${mod.id}: нет каталога ${mod.absDir}, пропуск`);
      continue;
    }

    const target = path.join(mod.absDir, mod.envFile || '.env');
    const lines = render(ctx);
    logger.pkg(mod.id, dryRun ? `dry-run ${target}` : target);
    if (!dryRun) {
      await writeEnvFile(target, lines);
    }
    written.push({ id: mod.id, path: target });
  }

  return { globalPath, written };
}

function buildContext(env, box, modules) {
  const missing = [];
  const take = (key, fallback) => {
    const value = env[key];
    if (value != null && String(value).trim() !== '') {
      return String(value);
    }
    if (fallback != null && fallback !== '') {
      return String(fallback);
    }
    missing.push(key);
    return '';
  };
  const opt = (key, fallback = '') => {
    const value = env[key];
    if (value != null && String(value).trim() !== '') {
      return String(value);
    }
    return fallback;
  };

  const portOf = (id, fallback) => {
    const fromEnv = env[`${id.toUpperCase()}_PORT`];
    if (fromEnv) {
      return String(fromEnv);
    }
    const mod = modules.find((item) => item.id === id) || box.modules.find((item) => item.id === id);
    return String(mod?.port || fallback);
  };

  const pivotPort = portOf('pivot', 3391);
  const adminPort = portOf('admin', 3372);
  const spreadsheetPort = portOf('spreadsheet', 3380);
  const esbHost = opt('ESB_HOST', 'localhost:3310');
  const adminHost = `localhost:${adminPort}`;
  const pivotEsBHost = `localhost:${pivotPort}`;

  return {
    missing,
    nodeEnv: opt('NODE_ENV', 'development'),
    dbHost: take('DB_HOST'),
    dbPort: take('DB_PORT', '5433'),
    dbUser: take('DB_USER'),
    dbPass: take('DB_PASS'),
    dbDatabase: take('DB_DATABASE'),
    dbSchema: take('DB_SCHEMA', 'pivot7'),
    dbTestDatabase: opt('DB_TEST_DATABASE'),
    dbDialect: opt('DB_DIALECT', 'postgres'),
    dbPool: opt('DB_POOL', '{"max":300,"min":0,"idle":1000}'),
    analyticHost: opt('ANALYTIC_HOST', 'https://localhost:3195'),
    esbHost,
    pivotPort,
    adminPort,
    spreadsheetPort,
    pivotEsBHost,
    corsOrigin: jsonOrigins(esbHost, adminHost),
    sessionSecret: opt('SESSION_SECRET', 'qwerty'),
    connectorSalt: opt('CONNECTOR_SALT', '123'),
    mfTypesPort: opt('MF_TYPES_PORT', '33702'),
    serverKey: opt('SERVER_KEY', '/atm/ssl/atm.key'),
    serverCert: opt('SERVER_CERT', '/atm/ssl/atm.cer'),
    serverCa: opt('SERVER_CA', '/atm/ssl/atm_chain.cer'),
    clientCa: opt('CLIENT_CA', '/atm/ssl/atm_chain.cer'),
  };
}

function jsonOrigins(...hosts) {
  const origins = [];
  for (const host of hosts) {
    const clean = String(host).replace(/^https?:\/\//, '');
    origins.push(`http://${clean}`, `https://${clean}`);
  }
  return JSON.stringify(origins).replace(/,/g, ', ');
}

function kv(key, value) {
  return `${key}=${formatEnvValue(value)}`;
}

function renderPivot(ctx) {
  return [
    HEADER,
    '',
    kv('DB_TEST_DATABASE', ctx.dbTestDatabase),
    kv('ANALYTIC_HOST', ctx.analyticHost),
    kv('NODE_ENV', ctx.nodeEnv),
    kv('CORS_ORIGIN', ctx.corsOrigin),
    kv('ESB_HOST', ctx.esbHost),
    '',
    kv('DB_USER', ctx.dbUser),
    kv('DB_DATABASE', ctx.dbDatabase),
    kv('DB_HOST', ctx.dbHost),
    kv('DB_PASS', ctx.dbPass),
    'LICENSE_KEY=',
    '',
    kv('DB_PORT', ctx.dbPort),
    kv('DB_SCHEMA', ctx.dbSchema),
    kv('DB_DIALECT', ctx.dbDialect),
    kv('DB_POOL', ctx.dbPool),
    '',
    kv('CHECK_CERT', 'false'),
    kv('SERVER_KEY', ctx.serverKey),
    kv('SERVER_CERT', ctx.serverCert),
    kv('SERVER_CA', ctx.serverCa),
    kv('CLIENT_CA', ctx.clientCa),
    kv('REJECT_UNAUTH', 'false'),
    '',
    kv('SESSION_SECRET', ctx.sessionSecret),
    kv('SALT_ROUND', '10'),
    'SALT=',
    '',
    kv('LOG_LEVEL', '0'),
    kv('LOG_PREFIX', 'true'),
    kv('WRITE_HTTP_LOG', 'true'),
    kv('ESB_NAME', 'engine'),
    '',
    kv('HOST', `localhost:${ctx.pivotPort}`),
    kv('SERVICE_NAME', 'engine'),
    kv('SESSIONS_PATH', './sessions/bi'),
    kv('PORT', ctx.pivotPort),
    kv('EXT_ENABLED', '[]'),
    '',
    kv('CACHE_ENABLED', 'false'),
    kv('DISABLE_DATA_CACHE', 'true'),
    kv('DISABLE_TREE_CACHE', 'false'),
    kv('DISABLE_OVERRITE_CACHE', 'true'),
    '',
    kv('CONNECTOR_SALT', ctx.connectorSalt),
  ];
}

function renderMigrations(ctx) {
  return [
    HEADER,
    '',
    kv('DB_TEST_DATABASE', ctx.dbTestDatabase),
    kv('ANALYTIC_HOST', ctx.analyticHost),
    kv('NODE_ENV', ctx.nodeEnv),
    kv('CORS_ORIGIN', jsonOrigins(ctx.esbHost)),
    kv('ESB_HOST', ctx.esbHost),
    '',
    kv('DB_USER', ctx.dbUser),
    kv('DB_DATABASE', ctx.dbDatabase),
    kv('DB_HOST', ctx.dbHost),
    kv('DB_PASS', ctx.dbPass),
    kv('DB_PORT', ctx.dbPort),
    kv('DB_SCHEMA', ctx.dbSchema),
    kv('DB_DIALECT', ctx.dbDialect),
    kv('DB_POOL', ctx.dbPool),
    '',
    kv('CHECK_CERT', 'false'),
    kv('SERVER_KEY', ctx.serverKey),
    kv('SERVER_CERT', ctx.serverCert),
    kv('SERVER_CA', ctx.serverCa),
    kv('CLIENT_CA', ctx.clientCa),
    kv('REJECT_UNAUTH', 'false'),
    '',
    kv('SESSION_SECRET', ctx.sessionSecret),
    kv('SALT_ROUND', '10'),
    'SALT=',
    '',
    kv('LOG_LEVEL', '0'),
    kv('LOG_PREFIX', 'true'),
    kv('WRITE_HTTP_LOG', 'true'),
    kv('ESB_NAME', 'engine'),
    '',
    kv('HOST', `localhost:${ctx.pivotPort}`),
    kv('SERVICE_NAME', 'engine'),
    kv('SESSIONS_PATH', './sessions/bi'),
    kv('PORT', ctx.pivotPort),
    kv('EXT_ENABLED', '[]'),
    '',
    kv('CACHE_ENABLED', 'false'),
    kv('DISABLE_DATA_CACHE', 'true'),
    kv('DISABLE_TREE_CACHE', 'false'),
    kv('DISABLE_OVERRITE_CACHE', 'true'),
    '',
    kv('CONNECTOR_SALT', ctx.connectorSalt),
  ];
}

function renderSpreadsheet(ctx) {
  return [
    HEADER,
    '',
    kv('NODE_ENV', ctx.nodeEnv),
    kv('ESB_HOST', ctx.pivotEsBHost),
    kv('ESB_NAME', 'backend'),
    '',
    kv('DB_TEST_DATABASE', ctx.dbTestDatabase),
    '',
    kv('DB_USER', ctx.dbUser),
    kv('DB_DATABASE', ctx.dbDatabase),
    kv('DB_HOST', ctx.dbHost),
    kv('DB_PASS', ctx.dbPass),
    kv('DB_PORT', ctx.dbPort),
    kv('DB_SCHEMA', ctx.dbSchema),
    '',
    kv('DB_DIALECT', ctx.dbDialect),
    kv('DB_POOL', ctx.dbPool),
    '',
    kv('SESSION_SECRET', ctx.sessionSecret),
    kv('SALT_ROUND', '10'),
    'SALT=',
    kv('SERVICE_NAME', 'engine'),
    kv('HOST', 'localhost'),
    kv('PORT', ctx.spreadsheetPort),
    kv('EXT_ENABLED', '[]'),
    '',
    kv('LOG_LEVEL', '3'),
    kv('LOG_PREFIX', 'true'),
    '',
    kv('DEFAULTROLES_USER', '[]'),
    kv('SHUTDOWN_TIMEOUT', '0'),
  ];
}

function renderAdmin(ctx) {
  return [
    HEADER,
    '',
    kv('NODE_ENV', ctx.nodeEnv),
    kv('CORS_ORIGIN', jsonOrigins(ctx.esbHost)),
    kv('STACK_TRACE_LIMIT', '100'),
    kv('COMPRESSION_CONFIG', '{"level":1}'),
    kv('LOG_LEVEL', '1'),
    kv('CACHE_ENABLED', 'false'),
    kv('REACT_APP_ESB_ENABLED', 'false'),
    '',
    kv('REACT_APP_BACKEND_PREFIX', '/api'),
    kv('ESB_HOST', ctx.pivotEsBHost),
    kv('PUBLIC_URL', '/'),
    kv('PORT', ctx.adminPort),
    kv('MF_TYPES_PORT', ctx.mfTypesPort),
    kv('MODULE_FEDERATION_CONTAINER_NAME', 'ADMINPANEL_UI_COMPONENTS'),
    '',
    'FILES="./src/components"',
  ];
}
