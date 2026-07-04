const pino = require('pino');
const { getEnv } = require('./config');

const logger = pino({
  level: getEnv('LOG_LEVEL', 'info'),
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
