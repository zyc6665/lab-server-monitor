/**
 * Typed error raised for any invalid configuration. Mirrors the behaviour of
 * `servermanage.ConfigError` from the Python oracle (a `ValueError` subclass).
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
