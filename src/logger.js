const Logger = require('jwt-pizza-logger');
const config = require('./config.js');

const logger = new Logger(config);

// Keep bound parameters (including passwords and session tokens) out of logs.
logger.dbLogger = (sql) => {
  if (!config.logging?.endpointUrl) return;
  try {
    logger.log('info', 'db', sql);
  } catch (error) {
    console.error('Error creating database log:', error);
  }
};

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
    console.error('Error pushing log:', error);
  }
};

function redact(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/^(password|token|jwt|accessToken|refreshToken|authorization|apiKey|secret)$/i.test(key)) return '[REDACTED]';
    return item;
  }));
}

function safeLog(level, type, data) {
  if (!config.logging?.endpointUrl) return;
  try {
    logger.log(level, type, redact(data));
  } catch (error) {
    console.error(`Error creating ${type} log:`, error);
  }
}

logger.factoryLogger = ({ user, error, ...data }) => {
  safeLog(error ? 'error' : logger.statusToLogLevel(data.statusCode), 'factory', {
    ...data,
    user: user ? { id: user.id, name: user.name, email: user.email, roles: user.roles } : null,
    ...(error ? { error: { message: error.message, stack: error.stack } } : {}),
  });
};

logger.unhandledErrorLogger = (error, context = {}) => {
  safeLog('error', 'unhandledError', {
    ...context,
    message: error?.message ?? String(error),
    stack: error?.stack,
    statusCode: error?.statusCode ?? 500,
  });
};

let processErrorLoggingInstalled = false;
logger.installProcessErrorLogging = () => {
  if (processErrorLoggingInstalled) return;
  processErrorLoggingInstalled = true;
  // Observe fatal errors (including default unhandled rejections) without
  // suppressing Node's normal crash. stderr survives a failed remote push.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    console.error('Unhandled process error:', error);
    logger.unhandledErrorLogger(error, { origin });
  });
};

// Observe completed responses, including res.end(), parser errors, and 404s.
logger.httpLogger = (req, res, next) => {
  if (config.logging?.endpointUrl) {
    const start = process.hrtime.bigint();
    const chunks = [];
    function capture(chunk, encoding) {
      if (typeof chunk === 'string') chunks.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    }
    const write = res.write;
    const end = res.end;
    res.write = function (chunk, encoding, callback) {
      capture(chunk, encoding);
      return write.call(this, chunk, encoding, callback);
    };
    res.end = function (chunk, encoding, callback) {
      capture(chunk, encoding);
      return end.call(this, chunk, encoding, callback);
    };
    res.once('finish', () => {
      let resBody = Buffer.concat(chunks).toString('utf8') || null;
      if (resBody && String(res.getHeader('Content-Type')).includes('application/json')) {
        try {
          resBody = JSON.parse(resBody);
        } catch {
          resBody = '[Invalid JSON response]';
        }
      }
      const user = req.user;
      logger.log(logger.statusToLogLevel(res.statusCode), 'http', {
        authorized: req.headers.authorization !== undefined,
        path: req.originalUrl.split('?')[0],
        method: req.method,
        statusCode: res.statusCode,
        user: user ? redact({ id: user.id, name: user.name, email: user.email, roles: user.roles }) : null,
        reqBody: redact(req.body),
        resBody: redact(resBody),
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
      });
    });
  }
  next();
};

module.exports = logger;
