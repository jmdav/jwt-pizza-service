const { EventEmitter } = require('events');
const os = require('os');

jest.mock('./config', () => ({ metrics: { source: 'test', endpointUrl: 'https://example.test/v1/metrics', accountId: '123', apiKey: 'secret' } }));
jest.mock('./database/database', () => ({ DB: { getLoggedInUserCount: jest.fn() } }));

const originalFetch = global.fetch;
let metrics;

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetModules();
  require('./database/database').DB.getLoggedInUserCount.mockResolvedValue(1);
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  // Each sample represents 50% CPU usage and 25% memory usage.
  let tick = 0;
  jest.spyOn(os, 'cpus').mockImplementation(() => [{ times: { idle: ++tick * 50, user: tick * 50 } }]);
  jest.spyOn(os, 'totalmem').mockReturnValue(100);
  jest.spyOn(os, 'freemem').mockReturnValue(75);
  metrics = require('./metrics');
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  global.fetch = originalFetch;
});

function response(statusCode, purchaseRevenue) {
  return Object.assign(new EventEmitter(), { statusCode, locals: { purchaseRevenue } });
}

async function report() {
  await jest.advanceTimersByTimeAsync(60000);
  const [url, options] = global.fetch.mock.calls.at(-1);
  expect(url).toBe('https://example.test/v1/metrics');
  expect(options.headers.Authorization).toBe(`Basic ${Buffer.from('123:secret').toString('base64')}`);
  expect(options.signal).toBeInstanceOf(AbortSignal);
  const values = JSON.parse(options.body).resourceMetrics[0].scopeMetrics[0].metrics;
  expect(new Set(values.map(({ name }) => name)).size).toBe(values.length);
  return Object.fromEntries(values.map((metric) => [metric.name, metric]));
}

test('exports outcomes, successful revenue, request duration, and system averages', async () => {
  const success = response(200, 12.34);
  const req = { method: 'POST', baseUrl: '/api/order', route: { path: '/' }, user: { id: 42 } };
  metrics.requestTracker(req, success, jest.fn());
  metrics.trackPurchase(req, success, jest.fn());
  success.emit('finish');

  const failure = response(500, 99);
  metrics.trackPurchase(req, failure, jest.fn());
  failure.emit('finish');
  for (const status of [200, 401]) {
    const auth = response(status);
    metrics.trackAuth(req, auth, jest.fn());
    auth.emit('finish');
  }
  metrics.recordFactoryLatency(1.5);
  const exported = await report();

  expect(exported['pizza.purchases'].sum.dataPoints.map((point) => point.asInt)).toEqual(['1', '1']);
  expect(exported['pizza.revenue'].sum.dataPoints[0].asDouble).toBe(12.34);
  const duration = exported['http.server.request.duration'].histogram.dataPoints[0];
  expect(duration.count).toBe('1');
  expect(duration.bucketCounts.reduce((sum, count) => sum + Number(count), 0)).toBe(1);
  expect(exported['pizza.factory.request.duration'].histogram.dataPoints[0].sum).toBe(1.5);
  expect(exported['users.active'].gauge.dataPoints[0].asInt).toBe('1');
  expect(exported['auth.attempts'].sum.dataPoints.map((point) => point.asInt)).toEqual(['1', '1']);
  expect(exported['system.cpu.usage'].gauge.dataPoints[0].asDouble).toBe(50);
  expect(exported['system.memory.usage'].gauge.dataPoints[0].asDouble).toBe(25);
});

test('keeps counters and histograms cumulative and counts idle logged-in users', async () => {
  const req = { method: 'GET', baseUrl: '/api/user', route: { path: '/:id' }, user: { id: 42 } };
  for (let i = 0; i < 2; i++) {
    const res = response(200);
    metrics.requestTracker(req, res, jest.fn());
    res.emit('finish');
  }
  for (const duration of [0.005, 0.006, 11]) metrics.recordFactoryLatency(duration);
  const first = await report();
  const second = await report();
  const count = second.requests.sum;
  expect(count.isMonotonic).toBe(true);
  expect(count.aggregationTemporality).toBe('AGGREGATION_TEMPORALITY_CUMULATIVE');
  expect(count.dataPoints[0].asInt).toBe('2');
  expect(count.dataPoints[0].startTimeUnixNano).toBe(first.requests.sum.dataPoints[0].startTimeUnixNano);
  expect(count.dataPoints[0].timeUnixNano).not.toBe(first.requests.sum.dataPoints[0].timeUnixNano);
  expect(count.dataPoints[0].attributes).toContainEqual({ key: 'endpoint', value: { stringValue: '[GET] /api/user/:id' } });
  const histogram = second['pizza.factory.request.duration'].histogram.dataPoints[0];
  expect(histogram.bucketCounts).toEqual(['1', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '1']);
  expect(histogram.count).toBe('3');
  expect(first['users.active'].gauge.dataPoints[0].asInt).toBe('1');
  expect(second['users.active'].gauge.dataPoints[0].asInt).toBe('1');
});

test('refreshes the logged-in user count every report without requiring requests', async () => {
  const count = require('./database/database').DB.getLoggedInUserCount;
  count.mockResolvedValueOnce(0).mockResolvedValueOnce(2).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
  for (const expected of ['0', '2', '1', '0']) {
    const exported = await report();
    expect(exported['users.active'].gauge.dataPoints[0].asInt).toBe(expected);
  }
  expect(count).toHaveBeenCalledTimes(4);
});

test('omits the user gauge on a database failure and continues exporting other metrics', async () => {
  const error = new Error('database unavailable');
  require('./database/database').DB.getLoggedInUserCount.mockRejectedValueOnce(error);
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const exported = await report();
  expect(exported['users.active']).toBeUndefined();
  expect(exported['pizza.purchases']).toBeDefined();
  expect(log).toHaveBeenCalledWith('Error counting logged-in users:', error);
  expect((await report())['users.active'].gauge.dataPoints[0].asInt).toBe('1');
});

test('does not count a request before finish and groups unmatched URLs', async () => {
  const res = response(404);
  const next = jest.fn();
  metrics.requestTracker({ method: 'GET', originalUrl: '/unknown?secret=value' }, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect((await report()).requests).toBeUndefined();
  res.emit('finish');
  const exported = await report();
  expect(exported.requests.sum.dataPoints[0].attributes).toContainEqual({ key: 'endpoint', value: { stringValue: '[GET] unmatched' } });
});

test('ignores invalid and negative revenue on successful purchases', async () => {
  for (const value of [undefined, NaN, Infinity, -1]) {
    const res = response(200, value);
    metrics.trackPurchase({}, res, jest.fn());
    res.emit('finish');
  }
  const exported = await report();
  expect(exported['pizza.purchases'].sum.dataPoints[0].asInt).toBe('4');
  expect(exported['pizza.revenue'].sum.dataPoints[0].asDouble).toBe(0);
});

test('preserves the mounted route label after Express unwinds an error', async () => {
  const req = { method: 'POST', baseUrl: '/api/order', route: { path: '/' } };
  const res = response(500);
  metrics.requestTracker(req, res, jest.fn());
  const next = jest.fn();
  metrics.trackRouter(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  req.baseUrl = '';
  res.emit('finish');
  const exported = await report();
  expect(exported.requests.sum.dataPoints[0].attributes).toContainEqual({ key: 'endpoint', value: { stringValue: '[POST] /api/order/' } });
});

test.each([
  ['HTTP failure', () => Promise.resolve({ ok: false, status: 503 })],
  ['network failure', () => Promise.reject(new Error('network unavailable'))],
])('handles %s and continues reporting', async (_name, fail) => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  global.fetch.mockImplementationOnce(fail);
  await report();
  expect(log).toHaveBeenCalledWith('Error pushing metrics:', expect.any(Error));
  await report();
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledTimes(1);
});

test('skips system gauges when CPU time has not advanced', async () => {
  os.cpus.mockReturnValue([{ times: { idle: 50, user: 50 } }]);
  const exported = await report();
  expect(exported['system.cpu.usage']).toBeUndefined();
  expect(exported['system.memory.usage']).toBeUndefined();
});

test('does not start timers without metrics configuration', () => {
  jest.clearAllTimers();
  jest.isolateModules(() => {
    require('./config').metrics = undefined;
    require('./metrics');
    expect(jest.getTimerCount()).toBe(0);
  });
});
