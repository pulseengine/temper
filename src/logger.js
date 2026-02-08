import pino from 'pino';

const defaultLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino/file', options: { destination: 1 } }
  })
});

let activeLogger = defaultLogger;

export function getLogger() {
  return activeLogger;
}

export function setLogger(log) {
  activeLogger = log || defaultLogger;
}

export function resetLogger() {
  activeLogger = defaultLogger;
}

export { defaultLogger };
