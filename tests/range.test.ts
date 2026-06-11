import { afterEach, describe, expect, it } from "vitest";
import {
  RANGE_STORAGE_KEY,
  parseRange,
  rangeFromParams,
  readStoredRange,
  storeRange,
  topBarMode,
  trailingRange,
} from "../src/lib/range";

const NOW = new Date("2026-06-10T12:00:00Z");

function params(query: string) {
  return new URLSearchParams(query);
}

describe("rangeFromParams (spec 10: the range lives in the URL)", () => {
  it("returns the URL's valid range", () => {
    expect(rangeFromParams(params("from=2026-05-01&to=2026-06-01"))).toEqual({
      from: "2026-05-01",
      to: "2026-06-01",
    });
  });

  it("is null on anything missing or malformed - never a guess", () => {
    expect(rangeFromParams(params(""))).toBeNull();
    expect(rangeFromParams(params("from=2026-05-01"))).toBeNull();
    expect(rangeFromParams(params("to=2026-06-01"))).toBeNull();
    expect(rangeFromParams(params("from=garbage&to=2026-06-01"))).toBeNull();
    expect(rangeFromParams(params("from=2026-6-1&to=2026-06-01"))).toBeNull();
    // from after to is contradictory input, not a range.
    expect(rangeFromParams(params("from=2026-06-02&to=2026-06-01"))).toBeNull();
  });

  it("parseRange falls back to the default trailing window", () => {
    expect(parseRange(params(""), NOW)).toEqual(trailingRange(30, NOW));
    expect(parseRange(params("from=2026-05-01&to=2026-06-01"), NOW)).toEqual({
      from: "2026-05-01",
      to: "2026-06-01",
    });
  });
});

describe("stored range (spec 10: the picker's fallback for bare URLs)", () => {
  // Node has no window; stub the slice the helpers touch.
  function stubStorage(initial: Record<string, string> = {}, failWrites = false) {
    const store = new Map(Object.entries(initial));
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (failWrites) throw new Error("quota");
          store.set(key, value);
        },
      },
    };
    return store;
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("is null server-side (no window)", () => {
    expect(readStoredRange()).toBeNull();
    storeRange({ from: "2026-06-01", to: "2026-06-10" }); // must not throw
  });

  it("round-trips a stored range", () => {
    stubStorage();
    expect(readStoredRange()).toBeNull();
    storeRange({ from: "2026-06-01", to: "2026-06-10" });
    expect(readStoredRange()).toEqual({ from: "2026-06-01", to: "2026-06-10" });
  });

  it("rejects garbage with the same rules as a URL", () => {
    const store = stubStorage({ [RANGE_STORAGE_KEY]: "not json" });
    expect(readStoredRange()).toBeNull();
    store.set(RANGE_STORAGE_KEY, JSON.stringify({ from: "2026-06-01" }));
    expect(readStoredRange()).toBeNull();
    store.set(RANGE_STORAGE_KEY, JSON.stringify({ from: "garbage", to: "2026-06-10" }));
    expect(readStoredRange()).toBeNull();
    store.set(
      RANGE_STORAGE_KEY,
      JSON.stringify({ from: "2026-06-11", to: "2026-06-10" }),
    );
    expect(readStoredRange()).toBeNull();
  });

  it("swallows write failures - the URL still carries the range", () => {
    stubStorage({}, true);
    storeRange({ from: "2026-06-01", to: "2026-06-10" }); // must not throw
    expect(readStoredRange()).toBeNull();
  });
});

describe("topBarMode (spec 10: the bar only where dates drive the data)", () => {
  const none = params("");

  it("full bar on range-driven pages", () => {
    for (const pathname of [
      "/",
      "/people",
      "/people/abc",
      "/roi",
      "/roi/coding/claude_code",
      "/products/abc",
      "/drill",
    ]) {
      expect(topBarMode(pathname, none)).toBe("full");
    }
    expect(topBarMode("/drill", params("view=outcomes"))).toBe("full");
    expect(topBarMode("/drill", params("view=metrics"))).toBe("full");
  });

  it("no bar at all where dates mean nothing", () => {
    for (const pathname of [
      "/settings",
      "/resolve",
      "/help",
      "/help/sdk",
      "/help/api",
    ]) {
      expect(topBarMode(pathname, none)).toBe("hidden");
    }
  });

  it("search without the picker on pages with their own time axis", () => {
    expect(topBarMode("/report", none)).toBe("search");
    expect(topBarMode("/keys/abc", none)).toBe("search");
    expect(topBarMode("/drill", params("view=runs"))).toBe("search");
    expect(topBarMode("/drill", params("view=invoices"))).toBe("search");
  });

  it("matches whole path segments, not prefixes", () => {
    expect(topBarMode("/reporting", none)).toBe("full");
    expect(topBarMode("/settingsx", none)).toBe("full");
  });
});
