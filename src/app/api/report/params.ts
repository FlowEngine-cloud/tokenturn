import { badRequest } from "@/lib/api";
import { cleanMonth } from "@/lib/products";
import { currentMonth } from "@/lib/report";

/** ?month=YYYY-MM - the report month; absent = the current UTC month. */
export function readMonth(req: Request): string | Response {
  const raw = new URL(req.url).searchParams.get("month");
  if (raw === null) return currentMonth();
  return cleanMonth(raw) ?? badRequest("month must be YYYY-MM");
}
