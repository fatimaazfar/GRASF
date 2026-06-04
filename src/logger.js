// spec: src/logger.js — Simple console logger. No dependencies.

export const log = {
  info:  (...args) => console.log(...args),
  warn:  (...args) => console.warn('Warning:', ...args),
  error: (...args) => console.error('Error:', ...args),
  debug: (...args) => { if (process.env.GRASF_DEBUG) console.error('[debug]', ...args) },
}
