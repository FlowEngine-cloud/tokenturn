"use client";

import { ArrowUpCircle } from "lucide-react";
import type { VersionInfo } from "@/lib/version";
import { useFetch } from "@/lib/use-fetch";

/**
 * "New version available" (spec 12b). Renders nothing unless the opt-in
 * release check (Settings, off by default) found a newer GitHub release.
 */
export function VersionBanner() {
  const { data } = useFetch<VersionInfo>("/api/version");
  if (!data?.updateAvailable) return null;
  return (
    <div className="flex items-center gap-2 border-b bg-accent px-4 py-1.5 text-sm md:px-6 print:hidden">
      <ArrowUpCircle className="h-4 w-4 shrink-0" />
      <span>
        {data.latest} is out (you run v{data.current})
      </span>
      <a
        href={data.releasesUrl}
        target="_blank"
        rel="noreferrer"
        className="font-medium underline underline-offset-2"
      >
        Release notes
      </a>
    </div>
  );
}
