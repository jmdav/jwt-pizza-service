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

test('omits credentials, bodies, and query strings', async () => {
  await request(app).post('/api/auth?token=query-secret').send({ password: 'body-secret' });
  const body = global.fetch.mock.calls[0][1].body;
  expect(body).not.toContain('query-secret');
  expect(body).not.toContain('body-secret');
  expect(body).not.toContain('reqBody');
  expect(body).not.toContain('resBody');
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
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    config.logging = logging;
  }
});
