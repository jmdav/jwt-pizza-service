const config = require('./config').metrics || {};
const os = require('os');
const { DB } = require('./database/database');

// Counters and histograms are cumulative for the lifetime of this process.
const startedAt = unixNano();
const requests = new Map();
const latency = new Map();
const bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const purchases = { success: 0, failed: 0 };
const authAttempts = { success: 0, failed: 0 };
let revenue = 0;

// System gauges describe the latest reporting interval.
let previousCpu;
let cpuSum = 0;
let memorySum = 0;
let samples = 0;

function unixNano() {
  return String(BigInt(Date.now()) * 1000000n);
}

function cpuTimes() {
  const totals = { idle: 0, total: 0 };
  for (const cpu of os.cpus()) {
    totals.idle += cpu.times.idle;
    totals.total += Object.values(cpu.times).reduce((sum, time) => sum + time, 0);
  }
  return totals;
}

function sampleSystem() {
  const current = cpuTimes();
  const total = current.total - previousCpu.total;
  if (total > 0) {
    cpuSum += 100 * (1 - (current.idle - previousCpu.idle) / total);
    memorySum += 100 * (1 - os.freemem() / os.totalmem());
    samples++;
  }
  previousCpu = current;
}

function recordLatency(name, endpoint, duration) {
  const key = `${name}|${endpoint}`;
  if (!latency.has(key)) {
    latency.set(key, { name, endpoint, count: 0, sum: 0, buckets: Array(bounds.length + 1).fill(0) });
  }
  const series = latency.get(key);
  series.count++;
  series.sum += duration;
  const index = bounds.findIndex((bound) => duration <= bound);
  series.buckets[index === -1 ? bounds.length : index]++;
}

function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();
  res.once('finish', () => {
    // Route templates keep IDs and query strings out of metric labels.
    const baseUrl = res.locals.metricsBaseUrl ?? req.baseUrl;
    const route = req.route ? `${baseUrl}${req.route.path}` : 'unmatched';
    const endpoint = `[${req.method}] ${route}`;
    requests.set(endpoint, (requests.get(endpoint) || 0) + 1);
    recordLatency('http.server.request.duration', endpoint, Number(process.hrtime.bigint() - start) / 1e9);
  });
  next();
}

function trackRouter(req, res, next) {
  // Express clears baseUrl when an error leaves a mounted router.
  res.locals.metricsBaseUrl = req.baseUrl;
  next();
}

function outcome(res) {
  return res.statusCode >= 200 && res.statusCode < 300 ? 'success' : 'failed';
}

function trackAuth(req, res, next) {
  res.once('finish', () => authAttempts[outcome(res)]++);
  next();
}

function trackPurchase(req, res, next) {
  res.once('finish', () => {
    const result = outcome(res);
    purchases[result]++;
    if (result === 'success' && Number.isFinite(res.locals.purchaseRevenue) && res.locals.purchaseRevenue >= 0) {
      revenue += res.locals.purchaseRevenue;
    }
  });
  next();
}

function recordFactoryLatency(duration) {
  recordLatency('pizza.factory.request.duration', 'POST /api/order', duration);
}

async function sendMetrics() {
  const metrics = new Map();
  const timeUnixNano = unixNano();

  // OTLP requires one metric per name, with a data point for each label set.
  function addMetric(name, unit, type, value, attributes = {}) {
    const dataPoint = {
      ...value,
      timeUnixNano,
      attributes: Object.entries({ ...attributes, source: config.source || 'jwt-pizza-service' }).map(([key, value]) => ({ key, value: { stringValue: value } })),
    };
    if (!metrics.has(name)) {
      const aggregation = { dataPoints: [] };
      if (type !== 'gauge') aggregation.aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
      if (type === 'sum') aggregation.isMonotonic = true;
      metrics.set(name, { name, unit, [type]: aggregation });
    }
    if (type !== 'gauge') dataPoint.startTimeUnixNano = startedAt;
    metrics.get(name)[type].dataPoints.push(dataPoint);
  }

  for (const [endpoint, count] of requests) {
    addMetric('requests', '1', 'sum', { asInt: String(count) }, { endpoint });
  }
  for (const outcome of ['success', 'failed']) {
    addMetric('pizza.purchases', '1', 'sum', { asInt: String(purchases[outcome]) }, { outcome });
    addMetric('auth.attempts', '1', 'sum', { asInt: String(authAttempts[outcome]) }, { outcome });
  }
  addMetric('pizza.revenue', '1', 'sum', { asDouble: revenue });
  for (const series of latency.values()) {
    addMetric(series.name, 's', 'histogram', {
      count: String(series.count),
      sum: series.sum,
      bucketCounts: series.buckets.map(String),
      explicitBounds: bounds,
    }, { endpoint: series.endpoint });
  }
  try {
    // Count people, rather than sessions: one user may have multiple tokens.
    const loggedInUsers = await DB.getLoggedInUserCount();
    addMetric('users.active', '1', 'gauge', { asInt: String(loggedInUsers) });
  } catch (error) {
    // A failed query must not report a misleading zero or block other metrics.
    console.error('Error counting logged-in users:', error);
  }
  if (samples) {
    addMetric('system.memory.usage', '%', 'gauge', { asDouble: memorySum / samples });
    addMetric('system.cpu.usage', '%', 'gauge', { asDouble: cpuSum / samples });
  }
  cpuSum = 0;
  memorySum = 0;
  samples = 0;

  try {
    const response = await fetch(config.endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.accountId}:${config.apiKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [...metrics.values()] }] }] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`HTTP status: ${response.status}`);
  } catch (error) {
    console.error('Error pushing metrics:', error);
  }
}

// Optional telemetry must not prevent the service (or tests) from exiting.
if (config.endpointUrl) {
  previousCpu = cpuTimes();
  setInterval(sampleSystem, 10000).unref();
  setInterval(sendMetrics, 60000).unref();
}

module.exports = { requestTracker, trackRouter, trackPurchase, trackAuth, recordFactoryLatency };
