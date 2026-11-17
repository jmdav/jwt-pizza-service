const Logger = require('jwt-pizza-logger');
const config = require('./config.js');

const logger = new Logger(config);

// Send directly to Loki: the package's default transport also contacts the
// factory and evaluates its response as JavaScript.
logger.sendLogToGrafana = async (event) => {
  const logging = config.logging;
  if (!logging?.endpointUrl) return;

  try {
    const response = await fetch(logging.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${logging.accountId}:${logging.apiKey}`).toString('base64')}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`HTTP status: ${response.status}`);
  } catch (error) {
    console.error('Error pushing HTTP log:', error);
  }
};

// Observe completed responses, including res.end(), parser errors, and 404s.
// Bodies, query strings, and authorization values can contain credentials.
logger.httpLogger = (req, res, next) => {
  if (config.logging?.endpointUrl) {
    const start = process.hrtime.bigint();
    res.once('finish', () => {
      logger.log(logger.statusToLogLevel(res.statusCode), 'http', {
        authorized: !!req.headers.authorization,
        path: req.originalUrl.split('?')[0],
        method: req.method,
        statusCode: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
      });
    });
  }
  next();
};

module.exports = logger;
