export type LogLevel = "info" | "warning" | "error";

export interface LogContext {
  [key: string]: unknown;
}

export class Logger {
  constructor(private readonly namespace: string) {}

  private emit(level: LogLevel, message: string, context?: LogContext): void {
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      namespace: this.namespace,
      message,
      context: context ?? {},
    };
    const line = JSON.stringify(payload);
    if (level === "error") {
      process.stderr.write(`${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  }

  info(message: string, context?: LogContext): void {
    this.emit("info", message, context);
  }

  warning(message: string, context?: LogContext): void {
    this.emit("warning", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.emit("error", message, context);
  }
}
