import type { EngineLogger } from './flowEngine.js';

/** JSON-логгер воркера (pino-совместимая форма, без содержимого сообщений §16.3). */
export function createEngineLogger(): EngineLogger {
  return {
    info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
    warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
    error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
  };
}
