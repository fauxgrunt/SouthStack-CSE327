/**
 * Centralized logging utility for SouthStack IDE
 * Provides conditional logging based on environment
 */

const isDevelopment = import.meta.env.DEV;

export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
}

interface LogOptions {
  component?: string;
  data?: unknown;
}

class Logger {
  private isEnabled: boolean;

  constructor() {
    this.isEnabled = isDevelopment;
  }

  private formatMessage(
    level: LogLevel,
    message: string,
    options?: LogOptions,
  ): string {
    const timestamp = new Date().toISOString();
    const component = options?.component ? `[${options.component}]` : "";
    return `${timestamp} ${level} ${component} ${message}`;
  }

  debug(message: string, options?: LogOptions): void {
    if (this.isEnabled) {
      console.log(
        this.formatMessage(LogLevel.DEBUG, message, options),
        options?.data || "",
      );
    }
  }

  info(message: string, options?: LogOptions): void {
    if (this.isEnabled) {
      console.info(
        this.formatMessage(LogLevel.INFO, message, options),
        options?.data || "",
      );
    }
  }

  warn(message: string, options?: LogOptions): void {
    if (this.isEnabled) {
      console.warn(
        this.formatMessage(LogLevel.WARN, message, options),
        options?.data || "",
      );
    }
  }

  error(message: string, error?: Error | unknown, options?: LogOptions): void {
    // Always log errors, even in production
    console.error(
      this.formatMessage(LogLevel.ERROR, message, options),
      error || "",
    );
  }

  /**
   * Conditional logging for production builds
   * Use this for important events that should be logged in production
   */
  production(message: string, options?: LogOptions): void {
    console.log(
      this.formatMessage(LogLevel.INFO, message, options),
      options?.data || "",
    );
  }
}

// Export singleton instance
export const logger = new Logger();
