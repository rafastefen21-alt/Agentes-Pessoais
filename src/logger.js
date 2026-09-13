import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[config.logLevel] ?? 20;

function fmt(level, msg, meta) {
  const ts = new Date().toISOString();
  const extra = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${ts} [${level.toUpperCase()}] ${msg}${extra}`;
}

export const logger = {
  debug: (m, meta) => min <= 10 && console.log(fmt('debug', m, meta)),
  info: (m, meta) => min <= 20 && console.log(fmt('info', m, meta)),
  warn: (m, meta) => min <= 30 && console.warn(fmt('warn', m, meta)),
  error: (m, meta) => min <= 40 && console.error(fmt('error', m, meta)),
};
export default logger;
