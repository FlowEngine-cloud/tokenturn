/**
 * Structured JSON logger. One JSON object per line on stdout (stderr for
 * error level). Zero dependencies.
 *
 * Usage:
 *   logger.info("sync started", { connector: "anthropic" });
 *   const log = logger.child({ requestId });
 *   log.error("sync failed", { error: err });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause !== undefined
        ? { cause: serializeValue(value.cause) }
        : {}),
    };
  }
  return value;
}

function serializeFields(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = serializeValue(value);
  }
  return out;
}

function emit(level: LogLevel, bound: LogFields, msg: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const entry = {
    level,
    time: new Date().toISOString(),
    msg,
    ...serializeFields(bound),
    ...(fields ? serializeFields(fields) : {}),
  };
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    // Circular or otherwise unserializable fields: keep the line, drop them.
    line = JSON.stringify({ level, time: entry.time, msg, _droppedFields: true });
  }
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(line + "\n");
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function makeLogger(bound: LogFields): Logger {
  return {
    debug: (msg, fields) => emit("debug", bound, msg, fields),
    info: (msg, fields) => emit("info", bound, msg, fields),
    warn: (msg, fields) => emit("warn", bound, msg, fields),
    error: (msg, fields) => emit("error", bound, msg, fields),
    child: (fields) => makeLogger({ ...bound, ...fields }),
  };
}

export const logger: Logger = makeLogger({});
