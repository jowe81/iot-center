const levels = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const resolveLevel = (level) => {
  if (level === true) return 'debug';
  if (level === false) return 'error';
  if (level === null || level === undefined) return 'info';
  return level;
};

const logger = {
  info: (message, logLevel) => {
    const level = resolveLevel(logLevel);
    if (levels.info < levels[level]) return;
    console.log(`[INFO]  ${new Date().toISOString()} - ${message}`);
  },
  warn: (message, logLevel) => {
    const level = resolveLevel(logLevel);
    if (levels.warn < levels[level]) return;
    console.warn(`[WARN]  ${new Date().toISOString()} - ${message}`);
  },
  error: (message, error, logLevel) => {
    const level = resolveLevel(logLevel);
    if (levels.error < levels[level]) return;
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error ? error : '');
  },
  debug: (message, logLevel) => {
    const level = resolveLevel(logLevel);
    if (levels.debug < levels[level]) return;
    console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`);
  }
};

export default logger;