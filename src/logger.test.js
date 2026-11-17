const request = require('supertest');

jest.mock('./config.js', () => ({
  jwtSecret: 'test',
  factory: { url: 'https://factory.example.test' },
  db: { connection: { host: 'localhost' } },
  logging: { source: 'test', endpointUrl: 'https://logs.example.test/loki/api/v1/push', accountId: '123', apiKey: 'secret' },
}));
jest.mock('./database/database.js', () => ({ DB: { getMenu: jest.fn() }, Role: {} }));

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
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('logs rejected route handlers as errors', async () => {
  DB.getMenu.mockRejectedValueOnce(new Error('database unavailable'));
  const response = await request(app).get('/api/order/menu');
  expect(response.status).toBe(500);
  const event = JSON.parse(global.fetch.mock.calls[0][1].body);
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
  expect(log).toHaveBeenCalledWith('Error pushing HTTP log:', expect.any(Error));
  expect((await request(app).get('/')).status).toBe(200);
});

test('skips logging when configuration is absent', async () => {
  const logging = config.logging;
  delete config.logging;
  try {
    expect((await request(app).get('/')).status).toBe(200);
    await logger.sendLogToGrafana({ streams: [] });
    logger.dbLogger('SELECT 1');
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
