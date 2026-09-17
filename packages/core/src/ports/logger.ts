export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * PORT. VS Code supplies an implementation backed by an OutputChannel; the
 * desktop app will supply one backed by electron-log. Core never calls
 * `console` directly, because in an extension host that output goes nowhere
 * useful.
 */
export interface Logger {
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void;
  /** Child logger that prefixes every message, e.g. per connection. */
  child(scope: string): Logger;
}

export const NOOP_LOGGER: Logger = {
  log() {},
  child() {
    return NOOP_LOGGER;
  },
};
