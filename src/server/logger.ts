type LogLevel = "debug" | "info" | "warn" | "error";

interface LogFields {
  [key: string]: unknown;
}

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (!shouldLog(level)) return;
  const line = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };

  const serialized = JSON.stringify(line);

  if (level === "error") {
    console.error(serialized);
    return;
  }

  console.log(serialized);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function shouldLog(level: LogLevel): boolean {
  const configured = process.env.LOG_LEVEL ?? "info";
  const priority: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const minimum = priority[configured as LogLevel] ?? priority.info;
  return priority[level] >= minimum;
}
