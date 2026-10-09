import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 300_000;
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
  const contents = await fs.readFile(ENV_PATH, 'utf8');
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf('=');
    if (split <= 0) throw new Error('Invalid local .env line');
    const name = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim();
    if (result.has(name) || !/^[A-Z][A-Z0-9_]*$/.test(name) || !value || /[\r\n]/.test(value)) {
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
  return { apiOrigin, keys, fingerprint: createHash('sha256').update(contents).digest('hex') };
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

const getDailyUsage = async (config, { force }) => {
  const now = Date.now();
  if (
    !force
    && cachedUsage?.fingerprint === config.fingerprint
    && now - cachedUsage.fetchedAt < CACHE_TTL_MS
  ) {
    return { results: cachedUsage.results, fetchedAt: cachedUsage.fetchedAt };
  }
  if (pendingUsage?.fingerprint === config.fingerprint) return pendingUsage.promise;

  const promise = Promise.all(config.keys.map(key => readCost(key, config.apiOrigin)))
    .then(results => {
      const fetchedAt = Date.now();
      cachedUsage = { fingerprint: config.fingerprint, results, fetchedAt };
      return { results, fetchedAt };
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
