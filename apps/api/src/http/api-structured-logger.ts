import type { LoggerService } from "@nestjs/common";
import { type LogLevel, writeStructuredLog } from "@xhs-agentic/observability";

export class ApiStructuredLogger implements LoggerService {
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write("info", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    const context = [...optionalParams].reverse().find((value) => typeof value === "string");
    writeStructuredLog({
      event: "nestjs.runtime",
      fields: {
        context,
        message,
        parameters: optionalParams.length > 1 ? optionalParams.slice(0, -1) : undefined,
      },
      level,
      service: "api",
    });
  }
}
