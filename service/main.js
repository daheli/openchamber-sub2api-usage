import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 600_000;
const REQUEST_BODY_MAX_BYTES = 1024;
const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(DIRECTORY, '..', '.env');
const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN;
let cachedUsage = null;
let pendingUsage = null;

const respond = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};

const readEnv = async () => {
  const info = await fs.lstat(ENV_PATH);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('The local .env file must be a regular file with mode 0600');
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('The local .env file must belong to the service user');
  }

  const result = new Map();
  const optionalSecrets = new Set(['SUB2API_ADMIN_ACCESS_TOKEN', 'SUB2API_ADMIN_REFRESH_TOKEN']);
  const contents = await fs.readFile(ENV_PATH, 'utf8');
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf('=');
    if (split <= 0) throw new Error('Invalid local .env line');
    const name = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim();
    if (result.has(name) || !/^[A-Z][A-Z0-9_]*$/.test(name) || (!value && !optionalSecrets.has(name)) || /[\r\n]/.test(value)) {
      throw new Error('Invalid local .env entry');
    }
    result.set(name, value);
  }

  const configuredOrigin = result.get('SUB2API_API_ORIGIN');
  let apiOrigin;
  try {
    const parsed = new URL(configuredOrigin);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) throw new Error('invalid origin');
    apiOrigin = parsed.origin;
  } catch {
    throw new Error('SUB2API_API_ORIGIN must be an HTTPS origin');
  }

  const keys = [1, 2].map(id => {
    const keyId = Number(result.get(`SUB2API_KEY_${id}_ID`));
    const name = result.get(`SUB2API_KEY_${id}_NAME`);
    const token = result.get(`SUB2API_KEY_${id}_TOKEN`);
    if (keyId !== id || !name || !token || token.startsWith('replace-with-')) {
      throw new Error('Both Sub2API key entries must be configured');
    }
    return { id: keyId, name, token };
  });
  if (keys[0].id === keys[1].id || keys[0].token === keys[1].token) {
    throw new Error('The two Sub2API key entries must be distinct');
  }
  const rawAccountId = result.get('SUB2API_CODEX_ACCOUNT_ID') ?? '';
  const accountId = Number(rawAccountId);
  if (rawAccountId && !rawAccountId.startsWith('replace-with-') && (!Number.isSafeInteger(accountId) || accountId < 1)) {
    throw new Error('SUB2API_CODEX_ACCOUNT_ID must be a positive integer');
  }
  const adminAccessToken = result.get('SUB2API_ADMIN_ACCESS_TOKEN') ?? '';
  const adminRefreshToken = result.get('SUB2API_ADMIN_REFRESH_TOKEN') ?? '';
  return {
    apiOrigin,
    keys,
    codexAccountId: Number.isSafeInteger(accountId) && accountId > 0 ? accountId : null,
    adminAccessToken: adminAccessToken.startsWith('replace-with-') ? '' : adminAccessToken,
    adminRefreshToken: adminRefreshToken.startsWith('replace-with-') ? '' : adminRefreshToken,
    fingerprint: createHash('sha256').update(contents).digest('hex'),
  };
};

const readCost = async ({ id, name, token }, apiOrigin) => {
  try {
    const url = new URL('/v1/usage?days=1&timezone=Asia%2FShanghai', apiOrigin);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { id, name, ok: false, error: response.status === 401 || response.status === 403 ? 'credential-rejected' : 'upstream-error' };
    }
    const payload = await response.json();
    const cost = payload?.usage?.today?.actual_cost;
    if (payload?.isValid === false || typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
      return { id, name, ok: false, error: 'invalid-usage-data' };
    }
    return { id, name, ok: true, todayActualCost: cost };
  } catch (error) {
    const code = error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'request-failed';
    return { id, name, ok: false, error: code };
  }
};

const replaceAdminTokens = async (accessToken, refreshToken) => {
  const info = await fs.lstat(ENV_PATH);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('The local .env file must be a regular file with mode 0600');
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('The local .env file must belong to the service user');
  }

  const source = await fs.readFile(ENV_PATH, 'utf8');
  const values = new Map([
    ['SUB2API_ADMIN_ACCESS_TOKEN', accessToken],
    ['SUB2API_ADMIN_REFRESH_TOKEN', refreshToken],
  ]);
  const written = new Set();
  const lines = source.split(/\r?\n/).map(line => {
    const split = line.indexOf('=');
    if (split < 0) return line;
    const name = line.slice(0, split).trim();
    if (!values.has(name)) return line;
    written.add(name);
    return `${name}=${values.get(name)}`;
  });
  for (const [name, value] of values) {
    if (!written.has(name)) lines.push(`${name}=${value}`);
  }

  const tempPath = `${ENV_PATH}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tempPath, ENV_PATH);
    await fs.chmod(ENV_PATH, 0o600);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
};

const refreshAdminTokens = async (config) => {
  if (!config.adminRefreshToken) return null;
  try {
    const response = await fetch(new URL('/api/v1/auth/refresh', config.apiOrigin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refresh_token: config.adminRefreshToken }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const envelope = await response.json();
    if (envelope?.code !== 0 || !envelope.data) return null;
    const accessToken = envelope.data.access_token;
    const refreshToken = envelope.data.refresh_token ?? config.adminRefreshToken;
    if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) return null;
    await replaceAdminTokens(accessToken, refreshToken);
    return await readEnv();
  } catch {
    return null;
  }
};

const accessTokenExpiresSoon = (token) => {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return true;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now() + 60_000;
  } catch {
    return true;
  }
};

const getCodex7dUsage = async (config) => {
  const failure = (error) => ({
    ok: false,
    ...(config.codexAccountId ? { accountId: config.codexAccountId } : {}),
    error,
  });
  if (!config.codexAccountId) return failure('account-id-not-configured');
  if (!config.adminAccessToken && !config.adminRefreshToken) {
    return failure('admin-credentials-not-configured');
  }

  let auth = config;
  if (!auth.adminAccessToken || accessTokenExpiresSoon(auth.adminAccessToken)) {
    auth = await refreshAdminTokens(auth);
    if (!auth) return failure('admin-login-expired');
  }

  const url = new URL(`/api/v1/admin/accounts/${config.codexAccountId}/usage?source=active`, config.apiOrigin);
  const send = (token) => fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  try {
    let response = await send(auth.adminAccessToken);
    if (response.status === 401) {
      auth = await refreshAdminTokens(auth);
      if (!auth) return failure('admin-login-expired');
      response = await send(auth.adminAccessToken);
    }
    if (response.status === 401) return failure('admin-login-expired');
    if (response.status === 403) return failure('admin-permission-denied');
    if (!response.ok) return failure('admin-usage-unavailable');

    const envelope = await response.json();
    if (envelope?.code !== 0 || !envelope.data) return failure('admin-usage-unavailable');
    const usedPercent = envelope.data.seven_day?.utilization;
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) {
      return failure('codex-7d-unavailable');
    }
    return {
      ok: true,
      accountId: config.codexAccountId,
      usedPercent,
      remainingSeconds: Number.isFinite(envelope.data.seven_day.remaining_seconds)
        ? Math.max(0, Math.floor(envelope.data.seven_day.remaining_seconds))
        : null,
      resetsAt: envelope.data.seven_day.resets_at ?? null,
      updatedAt: envelope.data.updated_at ?? null,
    };
  } catch {
    return failure('admin-usage-unavailable');
  }
};

const getDailyUsage = async (config, { force }) => {
  const now = Date.now();
  if (
    !force
    && cachedUsage?.fingerprint === config.fingerprint
    && now - cachedUsage.fetchedAt < CACHE_TTL_MS
  ) {
      return { results: cachedUsage.results, codex7d: cachedUsage.codex7d, fetchedAt: cachedUsage.fetchedAt };
  }
  if (pendingUsage?.fingerprint === config.fingerprint) return pendingUsage.promise;

  const promise = Promise.all([
    Promise.all(config.keys.map(key => readCost(key, config.apiOrigin))),
    getCodex7dUsage(config),
  ]).then(([results, codex7d]) => {
      const fetchedAt = Date.now();
      cachedUsage = { fingerprint: config.fingerprint, results, codex7d, fetchedAt };
      return { results, codex7d, fetchedAt };
    });
  const pending = { fingerprint: config.fingerprint, promise };
  pendingUsage = pending;
  try {
    return await promise;
  } finally {
    if (pendingUsage === pending) pendingUsage = null;
  }
};

if (!Number.isInteger(port) || port < 1 || port > 65535 || !serviceToken) {
  throw new Error('Missing OpenChamber service runtime configuration');
}

const server = http.createServer(async (request, response) => {
  const authorization = request.headers.authorization ?? '';
  const expected = Buffer.from(serviceToken);
  const supplied = Buffer.from(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return respond(response, 401, { error: 'unauthorized' });
  }

  if (request.method === 'GET' && request.url === '/health') {
    try {
      await readEnv();
      return respond(response, 200, { status: 'ok' });
    } catch {
      return respond(response, 503, { error: 'local-credentials-unavailable' });
    }
  }

  if (request.method !== 'POST' || request.url !== '/usage') {
    return respond(response, 404, { error: 'not-found' });
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > REQUEST_BODY_MAX_BYTES) return respond(response, 413, { error: 'request-too-large' });
    chunks.push(chunk);
  }

  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !Array.isArray(body.keyIds)
      || body.keyIds.length !== 2
      || body.keyIds[0] !== 2
      || body.keyIds[1] !== 1
      || (body.force !== undefined && typeof body.force !== 'boolean')
    ) {
      return respond(response, 400, { error: 'invalid-key-selection' });
    }
    const config = await readEnv();
    const usage = await getDailyUsage(config, { force: body.force === true });
    return respond(response, 200, usage);
  } catch {
    return respond(response, 503, { error: 'local-credentials-unavailable' });
  }
});

server.on('error', () => process.exitCode = 1);
server.listen(port, HOST);
