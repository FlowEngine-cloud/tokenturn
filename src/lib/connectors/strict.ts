/**
 * Strict vendor-format parsing shared by all connectors. Any drift in a
 * vendor response - an unexpected field, a missing field, a changed type -
 * throws with the offending field named, so the sync fails with the drift
 * verbatim (and recorded-fixture tests turn vendor format changes into CI
 * failures) instead of writing bad numbers.
 */

export type Check = (v: unknown) => boolean;

export const isStr: Check = (v) => typeof v === "string";
export const nonEmptyStr: Check = (v) => typeof v === "string" && v.length > 0;
export const strOrNull: Check = (v) => v === null || typeof v === "string";
export const isInt: Check = (v) => typeof v === "number" && Number.isInteger(v);
/** Finite number - vendors that bill fractional cents report floats. */
export const isNum: Check = (v) => typeof v === "number" && Number.isFinite(v);
export const intOrNull: Check = (v) =>
  v === null || (typeof v === "number" && Number.isInteger(v));
export const isBool: Check = (v) => typeof v === "boolean";
export const isObj: Check = (v) => !!v && typeof v === "object" && !Array.isArray(v);
export const isArr: Check = (v) => Array.isArray(v);
export const literal =
  (want: string): Check =>
  (v) =>
    v === want;

export function parseStrict(
  label: string,
  raw: unknown,
  required: Record<string, Check>,
  optional: Record<string, Check> = {},
): Record<string, unknown> {
  if (!isObj(raw)) {
    throw new Error(`${label} is not an object: ${JSON.stringify(raw)}`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(key in required) && !(key in optional)) {
      throw new Error(`${label}: unexpected field "${key}"`);
    }
  }
  for (const [key, ok] of Object.entries(required)) {
    if (!ok(record[key])) {
      throw new Error(`${label}: missing or invalid "${key}"`);
    }
  }
  for (const [key, ok] of Object.entries(optional)) {
    if (key in record && !ok(record[key])) {
      throw new Error(`${label}: missing or invalid "${key}"`);
    }
  }
  return record;
}
