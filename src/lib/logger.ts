/**
 * Logging boundary.
 *
 * Centralised so that wiring Sentry later is a change in one file, and so there
 * is a single place enforcing the rule below.
 *
 * PRIVACY: this app handles health data. Never log food names, weights, body
 * measurements, photos, email addresses or access tokens. Log identifiers and
 * error shapes — enough to debug, never enough to reconstruct someone's diary.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

// Quiet under test as well as in production: a passing suite should not be
// buried in log output, and a failing one is easier to read without it.
const isDev = process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';

interface LogContext {
  readonly [key: string]: string | number | boolean | null | undefined;
}

function emit(level: Level, message: string, context?: LogContext): void {
  if (level === 'debug' && !isDev) return;

  const payload = context ? `${message} ${JSON.stringify(context)}` : message;

  switch (level) {
    case 'error':
      console.error(`[error] ${payload}`);
      break;
    case 'warn':
      console.warn(`[warn] ${payload}`);
      break;
    default:
      if (isDev) console.warn(`[${level}] ${payload}`);
  }
}

export const logger = {
  debug: (message: string, context?: LogContext) => emit('debug', message, context),
  info: (message: string, context?: LogContext) => emit('info', message, context),
  warn: (message: string, context?: LogContext) => emit('warn', message, context),
  error: (message: string, context?: LogContext) => emit('error', message, context),
};
