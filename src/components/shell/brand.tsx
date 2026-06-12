import { APP_NAME, BRAND_COLOR } from "@/lib/brand";

/**
 * The wordmark: small logo followed by the product name in brand green.
 * Sidebar, top bar and the mobile drawer all render this, so the brand
 * changes in one place.
 */
export function Brand() {
  return (
    <span className="flex items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.svg" alt="" className="h-5 w-5" />
      <span
        className="font-semibold tracking-tight"
        style={{ color: BRAND_COLOR }}
      >
        {APP_NAME}
      </span>
    </span>
  );
}
