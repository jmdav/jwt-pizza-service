const request = require('supertest');

jest.mock('./config.js', () => ({
  jwtSecret: 'test',
  factory: { url: 'https://factory.example.test' },
  db: { connection: { host: 'localhost' } },
  logging: { source: 'test', endpointUrl: 'https://logs.example.test/loki/api/v1/push', accountId: '123', apiKey: 'secret' },
}));
jest.mock('./database/database.js', () => ({ DB: { getMenu: jest.fn(), isLoggedIn: jest.fn(), addDinerOrder: jest.fn() }, Role: {} }));
jest.mock('./metrics.js', () => {
  const metrics = jest.requireActual('./metrics.js');
  return { ...metrics, recordFactoryLatency: jest.fn(metrics.recordFactoryLatency) };
});

const app = require('./service.js');
const logger = require('./logger.js');
const config = require('./config.js');
const { DB } = require('./database/database.js');
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

test.each([
  ['get', '/', 200, 'info'],
  ['head', '/', 200, 'info'],
  ['get', '/api/docs', 200, 'info'],
  ['post', '/api/auth', 400, 'warn'],
  ['get', '/api/user/me', 401, 'warn'],
  ['get', '/api/order', 401, 'warn'],
  ['post', '/api/franchise', 401, 'warn'],
  ['get', '/unknown', 404, 'warn'],
])('logs %s %s once with the final status', async (method, path, statusCode, level) => {
  const pending = request(app)[method](path);
  const response = await (method === 'post' ? pending.send({}) : pending);
  expect(response.status).toBe(statusCode);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe(config.logging.endpointUrl);
  expect(options.headers.Authorization).toBe(`Basic ${Buffer.from('123:secret').toString('base64')}`);
  expect(options.signal).toBeInstanceOf(AbortSignal);
  const { stream, values } = JSON.parse(options.body).streams[0];
  expect(stream).toEqual({ component: 'test', level, type: 'http' });
  expect(values[0][0]).toMatch(/^\d+$/);
  expect(JSON.parse(values[0][1])).toMatchObject({ method: method.toUpperCase(), path, statusCode, durationMs: expect.any(Number) });
});

test('logs parser errors before routing', async () => {
  const response = await request(app).post('/api/auth').set('Content-Type', 'application/json').send('{');
  expect(response.status).toBe(400);
  const events = global.fetch.mock.calls.map(([, options]) => JSON.parse(options.body).streams[0]);
  expect(events.map(({ stream }) => stream.type)).toEqual(['unhandledError', 'http']);
  expect(JSON.parse(events[0].values[0][1])).toMatchObject({ statusCode: 400, method: 'POST', path: '/api/auth' });
});

test('logs rejected route handlers as errors', async () => {
  DB.getMenu.mockRejectedValueOnce(new Error('database unavailable'));
  const response = await request(app).get('/api/order/menu');
  expect(response.status).toBe(500);
  const events = global.fetch.mock.calls.map(([, options]) => JSON.parse(options.body).streams[0]);
  expect(events.filter(({ stream }) => stream.type === 'unhandledError')).toHaveLength(1);
  const errorEntry = JSON.parse(events.find(({ stream }) => stream.type === 'unhandledError').values[0][1]);
  expect(errorEntry).toMatchObject({ message: 'database unavailable', stack: expect.stringContaining('database unavailable'), method: 'GET', path: '/api/order/menu' });
  const event = { streams: [events.find(({ stream }) => stream.type === 'http')] };
  expect(event.streams[0].stream.level).toBe('error');
  expect(JSON.parse(event.streams[0].values[0][1]).path).toBe('/api/order/menu');
});

test('includes bodies while redacting credentials and omitting query strings', async () => {
  await request(app).post('/api/auth?token=query-secret').send({ password: 'body-secret', name: 'diner' });
  const body = global.fetch.mock.calls[0][1].body;
  expect(body).not.toContain('query-secret');
  expect(body).not.toContain('body-secret');
  const entry = JSON.parse(JSON.parse(body).streams[0].values[0][1]);
  expect(entry.reqBody).toEqual({ password: '[REDACTED]', name: 'diner' });
  expect(entry.resBody).toEqual({ message: 'name, email, and password are required' });
  expect(entry.user).toBeNull();
  expect(entry.authorized).toBe(false);
});

test('includes the authenticated user and redacts nested response credentials', async () => {
  const express = require('express');
  const service = express();
  service.use(logger.httpLogger);
  service.use(express.json());
  service.post('/example', (req, res) => {
    req.user = { id: 42, name: 'diner', email: 'd@example.test', roles: [{ role: 'diner' }], password: 'user-secret' };
    res.json({ user: req.user, token: 'response-secret', items: [{ apiKey: 'nested-secret', count: 2 }] });
  });
  const response = await request(service).post('/example').set('Authorization', 'Bearer header-secret').send({ items: ['pizza'] });
  expect(response.body.token).toBe('response-secret');
  const body = global.fetch.mock.calls[0][1].body;
  for (const secret of ['user-secret', 'response-secret', 'nested-secret', 'header-secret']) expect(body).not.toContain(secret);
  const entry = JSON.parse(JSON.parse(body).streams[0].values[0][1]);
  expect(entry.authorized).toBe(true);
  expect(entry.user).toEqual({ id: 42, name: 'diner', email: 'd@example.test', roles: [{ role: 'diner' }] });
  expect(entry.reqBody).toEqual({ items: ['pizza'] });
  expect(entry.resBody.token).toBe('[REDACTED]');
  expect(entry.resBody.items).toEqual([{ apiKey: '[REDACTED]', count: 2 }]);
});

test('captures streamed text without changing the response', async () => {
  const express = require('express');
  const service = express();
  service.use(logger.httpLogger);
  service.get('/', (_req, res) => {
    res.write('hello ');
    res.end('world');
  });
  expect((await request(service).get('/')).text).toBe('hello world');
  const entry = JSON.parse(JSON.parse(global.fetch.mock.calls[0][1].body).streams[0].values[0][1]);
  expect(entry.resBody).toBe('hello world');
});

test.each([
  ['network error', () => Promise.reject(new Error('offline'))],
  ['HTTP error', () => Promise.resolve({ ok: false, status: 503 })],
])('contains transport failures: %s', async (_name, fail) => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  global.fetch.mockImplementationOnce(fail);
  await logger.sendLogToGrafana({ streams: [] });
  expect(log).toHaveBeenCalledWith('Error pushing log:', expect.any(Error));
  expect((await request(app).get('/')).status).toBe(200);
});

test('skips logging when configuration is absent', async () => {
  const logging = config.logging;
  delete config.logging;
  try {
    expect((await request(app).get('/')).status).toBe(200);
    await logger.sendLogToGrafana({ streams: [] });
    logger.dbLogger('SELECT 1');
    logger.factoryLogger({ reqBody: {}, resBody: {} });
    logger.unhandledErrorLogger(new Error('disabled logging'));
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    config.logging = logging;
  }
});

test('formats database logs for the same direct Grafana transport', () => {
  logger.dbLogger('SELECT id FROM user WHERE email=?');
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe(config.logging.endpointUrl);
  const { stream, values } = JSON.parse(options.body).streams[0];
  expect(stream).toEqual({ component: 'test', level: 'info', type: 'db' });
  expect(JSON.parse(values[0][1])).toBe('SELECT id FROM user WHERE email=?');
});

test('contains database log formatting failures', () => {
  jest.spyOn(logger, 'log').mockImplementationOnce(() => { throw new Error('logging failed'); });
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => logger.dbLogger('SELECT 1')).not.toThrow();
  expect(error).toHaveBeenCalledWith('Error creating database log:', expect.any(Error));
});

test.each([
  ['success', 200, { reportUrl: 'https://factory.test/report', jwt: 'factory-secret' }, 200, 'info'],
  ['factory failure', 503, { reportUrl: 'https://factory.test/report', message: 'oven offline' }, 500, 'error'],
  ['invalid JSON', 502, '<html>bad gateway</html>', 500, 'error'],
  ['network failure', null, null, 500, 'error'],
])('logs factory %s with user and bodies without changing the response', async (_name, status, body, serviceStatus, level) => {
  const jwt = require('jsonwebtoken');
  const metrics = require('./metrics.js');
  const user = { id: 42, name: 'diner', email: 'd@example.test', roles: [{ role: 'diner' }] };
  const token = jwt.sign(user, config.jwtSecret);
  const order = { id: 7, items: [{ menuId: 1, price: 2 }] };
  DB.isLoggedIn.mockResolvedValueOnce(true);
  DB.addDinerOrder.mockResolvedValueOnce(order);
  global.fetch.mockImplementation(async (url) => {
    if (url === config.logging.endpointUrl) return { ok: true };
    if (status === null) throw new Error('factory offline');
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  });

  metrics.recordFactoryLatency.mockClear();
  const response = await request(app).post('/api/order').set('Authorization', `Bearer ${token}`).send({ items: order.items });
  expect(response.status).toBe(serviceStatus);
  if (status === 200) expect(response.body).toMatchObject({ order, jwt: 'factory-secret', followLinkToEndChaos: body.reportUrl });
  if (status === 503) expect(response.body).toEqual({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: body.reportUrl });
  const factoryCall = global.fetch.mock.calls.find(([url]) => url !== config.logging.endpointUrl);
  expect(factoryCall[0]).toBe(`${config.factory.url}/api/order`);
  expect(JSON.parse(factoryCall[1].body)).toEqual({ diner: { id: user.id, name: user.name, email: user.email }, order });
  const logs = global.fetch.mock.calls.filter(([url]) => url === config.logging.endpointUrl).map(([, options]) => JSON.parse(options.body).streams[0]);
  const factoryLogs = logs.filter(({ stream }) => stream.type === 'factory');
  expect(factoryLogs).toHaveLength(1);
  expect(factoryLogs[0].stream.level).toBe(level);
  const entry = JSON.parse(factoryLogs[0].values[0][1]);
  expect(entry).toMatchObject({ user, method: 'POST', statusCode: status, reqBody: JSON.parse(factoryCall[1].body) });
  expect(entry.resBody).toEqual(status === 200 ? { ...body, jwt: '[REDACTED]' } : body);
  if (status === null || typeof body === 'string') expect(entry.error).toMatchObject({ message: expect.any(String), stack: expect.any(String) });
  const exported = JSON.stringify(logs);
  expect(exported).not.toContain('factory-secret');
  expect(exported).not.toContain(token);
  expect(metrics.recordFactoryLatency).toHaveBeenCalledTimes(1);
  expect(metrics.recordFactoryLatency).toHaveBeenCalledWith(expect.any(Number));
});

test('factory logging supports unauthenticated callers and contains formatter failures', () => {
  logger.factoryLogger({ statusCode: 200, reqBody: {}, resBody: {} });
  const event = JSON.parse(global.fetch.mock.calls[0][1].body).streams[0];
  expect(JSON.parse(event.values[0][1]).user).toBeNull();
  jest.spyOn(logger, 'log').mockImplementation(() => { throw new Error('formatter failed'); });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => logger.factoryLogger({ statusCode: 200 })).not.toThrow();
  expect(() => logger.unhandledErrorLogger(new Error('route failed'))).not.toThrow();
});

test.each([
  ['exception', "setImmediate(() => { throw new Error('fatal test'); });", 'uncaughtException'],
  ['rejection', "Promise.reject(new Error('fatal test'));", 'unhandledRejection'],
])('logs fatal %s once while preserving the process failure', (_name, trigger, origin) => {
  const { spawnSync } = require('node:child_process');
  const child = spawnSync(process.execPath, ['--unhandled-rejections=throw', '-e', `
    const configPath = require.resolve('./src/config.js');
    require.cache[configPath] = { exports: { logging: { source: 'test', endpointUrl: 'https://unused.test' } } };
    const logger = require('./src/logger.js');
    logger.sendLogToGrafana = (event) => require('node:fs').writeSync(1, JSON.stringify(event));
    logger.installProcessErrorLogging();
    logger.installProcessErrorLogging();
    ${trigger}
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000 });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(child.stderr).toContain('fatal test');
  const event = JSON.parse(child.stdout).streams[0];
  expect(event.stream).toMatchObject({ type: 'unhandledError', level: 'error' });
  expect(JSON.parse(event.values[0][1])).toMatchObject({ message: 'fatal test', stack: expect.stringContaining('fatal test'), origin });
});
