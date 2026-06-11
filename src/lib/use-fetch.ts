"use client";

import { useEffect, useState } from "react";

/**
 * URL-keyed JSON fetch for dashboard clients: state is keyed by the URL so
 * a filter/range change shows the skeleton again, never stale rows - and
 * no synchronous setState-in-effect (react-hooks compliant).
 */
export function useFetch<T>(url: string): { data: T | null; error: string | null } {
  const [state, setState] = useState<{
    url: string;
    data: T | null;
    error: string | null;
  }>({ url: "", data: null, error: null });
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || body === null) {
          setState({ url, data: null, error: body?.error ?? `request failed (${res.status})` });
        } else {
          setState({ url, data: body, error: null });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ url, data: null, error: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return state.url === url ? state : { data: null, error: null };
}
