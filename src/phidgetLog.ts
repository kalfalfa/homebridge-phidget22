import type { Logger } from 'homebridge';
import * as phidget22 from 'phidget22';

/**
 * The phidget22 Node library emits all log output via console.{log,warn,error,debug}
 * formatted as `[<timestamp> ]phidget22 <LEVEL> : message +Xms`. We patch the global
 * console methods once, inspect the first argument, and if it looks like a phidget22
 * log line we route it to Homebridge's Logger at the matching level. Everything else
 * passes through to the original console method untouched.
 */

export type PhidgetLogLevelName =
  | 'critical'
  | 'error'
  | 'warning'
  | 'info'
  | 'debug'
  | 'verbose';

const LEVEL_RE = /<(CRIT|ERROR|Warn|Info|Debug|Verb)>\s*:/;

interface Installed {
  logger: Logger;
}

let installed: Installed | null = null;

export function routePhidgetLogs(logger: Logger, level: PhidgetLogLevelName): void {
  applyLevel(level);

  if (installed) {
    installed.logger = logger;
    return;
  }

  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  const route = (fallback: (...a: unknown[]) => void, args: unknown[]): void => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    const m = first.match(LEVEL_RE);
    if (!m || !first.includes('phidget22')) {
      fallback(...args);
      return;
    }
    const msg = formatMessage(first, args.slice(1));
    const log = installed!.logger;
    switch (m[1]) {
      case 'CRIT':
      case 'ERROR':
        log.error(msg);
        break;
      case 'Warn':
        log.warn(msg);
        break;
      case 'Info':
        log.info(msg);
        break;
      case 'Debug':
      case 'Verb':
        log.debug(msg);
        break;
    }
  };

  console.log = (...a: unknown[]) => route(orig.log, a);
  console.warn = (...a: unknown[]) => route(orig.warn, a);
  console.error = (...a: unknown[]) => route(orig.error, a);
  console.debug = (...a: unknown[]) => route(orig.debug, a);

  installed = { logger };
}

function formatMessage(first: string, rest: unknown[]): string {
  // Strip the `[timestamp ]phidget22 <LEVEL> : ` prefix, the trailing ` -`
  // the library appends when it passes an object as a second arg, and any
  // ` +Nms` diff.
  const cleaned = first
    .replace(/^.*?phidget22\s*<[A-Za-z]+>\s*:\s*/, '')
    .replace(/\s+\+\d+ms\s*$/, '')
    .replace(/\s+-\s*$/, '');
  if (rest.length === 0) return cleaned;
  const tail = rest.map(formatValue).join(' ');
  return cleaned + ' ' + tail;
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function applyLevel(level: PhidgetLogLevelName): void {
  const mapped = {
    critical: phidget22.LogLevel.CRITICAL,
    error: phidget22.LogLevel.ERROR,
    warning: phidget22.LogLevel.WARNING,
    info: phidget22.LogLevel.INFO,
    debug: phidget22.LogLevel.DEBUG,
    verbose: phidget22.LogLevel.VERBOSE,
  }[level];
  phidget22.Log.enable(mapped);
}
