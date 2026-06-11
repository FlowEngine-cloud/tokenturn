import { afterEach, describe, expect, it, vi } from "vitest";
import { logger, setLogLevel } from "@/lib/logger";

function captureStream(stream: NodeJS.WriteStream) {
  const lines: string[] = [];
  const spy = vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never);
  return { lines, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel("info");
});

describe("logger", () => {
  it("writes one parseable JSON line with level, time, msg and fields", () => {
    const { lines } = captureStream(process.stdout);
    logger.info("sync started", { connector: "anthropic", rows: 42 });

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("sync started");
    expect(entry.connector).toBe("anthropic");
    expect(entry.rows).toBe(42);
    expect(new Date(entry.time).toString()).not.toBe("Invalid Date");
  });

  it("routes error level to stderr and serializes Error objects", () => {
    const { lines } = captureStream(process.stderr);
    logger.error("sync failed", { error: new Error("boom") });

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe("error");
    expect(entry.error.message).toBe("boom");
    expect(entry.error.name).toBe("Error");
    expect(typeof entry.error.stack).toBe("string");
  });

  it("child loggers carry bound fields into every line", () => {
    const { lines } = captureStream(process.stdout);
    const child = logger.child({ requestId: "req_1" });
    child.info("handled");

    const entry = JSON.parse(lines[0]);
    expect(entry.requestId).toBe("req_1");
    expect(entry.msg).toBe("handled");
  });

  it("filters below the configured level", () => {
    const { lines } = captureStream(process.stdout);
    logger.debug("hidden");
    expect(lines).toHaveLength(0);

    setLogLevel("debug");
    logger.debug("visible");
    expect(lines).toHaveLength(1);
  });

  it("never throws on unserializable fields", () => {
    const { lines } = captureStream(process.stdout);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => logger.info("weird", { circular })).not.toThrow();
    const entry = JSON.parse(lines[0]);
    expect(entry.msg).toBe("weird");
    expect(entry._droppedFields).toBe(true);
  });
});
