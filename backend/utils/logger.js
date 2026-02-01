const logger = {
  info: (message) => {
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`);
  },
  error: (message, error) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error ? error : '');
  },
  debug: (message) => {
    console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`);
  }
};

module.exports = logger;