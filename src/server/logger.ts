type LogLevel = "info" | "warn" | "error";

interface LogFields {
  [key: string]: unknown;
}

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
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
