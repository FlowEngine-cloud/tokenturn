"use client";

import Link from "next/link";
import type { TrendPoint } from "@/lib/overview";

/**
 * The daily-trend bar chart (Overview, person pages): one bar per UTC day,
 * each linking to the drill-down for exactly that day - the chart never
 * shows a number its bars can't prove.
 */
export function TrendBars({
  points,
  hrefFor,
  titleFor,
  heightClass = "h-28",
}: {
  points: TrendPoint[];
  hrefFor: (day: string) => string;
  titleFor: (point: TrendPoint) => string;
  heightClass?: string;
}) {
  const max = Math.max(...points.map((p) => p.cents), 1);
  return (
    <div className={`flex items-end gap-px ${heightClass}`}>
      {points.map((point) => (
        <Link
          key={point.day}
          href={hrefFor(point.day)}
          title={titleFor(point)}
          className="group flex h-full min-w-px flex-1 items-end"
        >
          <span
            className="w-full rounded-t-sm bg-primary/50 group-hover:bg-primary"
            style={{
              height: `${Math.max((point.cents / max) * 100, point.cents > 0 ? 2 : 0)}%`,
            }}
          />
        </Link>
      ))}
    </div>
  );
}

/** Tiny inline spend sparkline for table rows - presentational only; the
 * row it sits in links to the page where every bar drills. Long ranges
 * bucket-sum down to 36 bars so the shape stays readable in 96px. */
const SPARKLINE_BARS = 36;

export function Sparkline({ values: raw }: { values: number[] }) {
  let values = raw;
  if (raw.length > SPARKLINE_BARS) {
    const size = raw.length / SPARKLINE_BARS;
    values = Array.from({ length: SPARKLINE_BARS }, (_, bucket) =>
      raw
        .slice(Math.floor(bucket * size), Math.floor((bucket + 1) * size))
        .reduce((sum, v) => sum + v, 0),
    );
  }
  const max = Math.max(...values, 1);
  return (
    <div className="flex h-5 w-24 items-end gap-px" aria-hidden>
      {values.map((value, index) => (
        <span
          key={index}
          className="min-w-px flex-1 rounded-t-[1px] bg-primary/50"
          style={{
            height: `${Math.max((value / max) * 100, value > 0 ? 8 : 0)}%`,
          }}
        />
      ))}
    </div>
  );
}
