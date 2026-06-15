"use client";

import { createContext, useContext } from "react";

/**
 * Demo mode for the client (env DEMO_MODE=1, read server-side and handed
 * down once by the dashboard layout - never fetched, never flickers).
 *
 * The point (see isDemoMode in @/lib/demo): a live demo shows the WHOLE
 * product - every card, form and button is visible so a visitor sees the
 * real experience - but every write control is disabled, so nothing can be
 * clicked, saved or edited. The proxy still answers 403 to any write as the
 * backstop; this just makes the read-only truth visible instead of letting
 * a click fail.
 *
 * Two helpers cover every call site:
 * - useDemo(): the raw flag, to OR into a control's `disabled`.
 * - useCanWrite(isAdmin): show the control (admin OR demo) but block writes
 *   (demo). Components gate rendering on `show` and disable on `readOnly`.
 */
const DemoContext = createContext(false);

export function DemoProvider({
  value,
  children,
}: {
  value: boolean;
  children: React.ReactNode;
}) {
  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

/** True when the instance runs read-only for a live demo. */
export function useDemo(): boolean {
  return useContext(DemoContext);
}

/**
 * Write-access for one control given the caller's admin flag:
 * - `show`: render the control at all (a real admin, or anyone in demo so
 *   the full experience is on screen).
 * - `readOnly`: the control must be disabled (demo mode) - a visitor sees
 *   it but can't use it.
 */
export function useCanWrite(isAdmin: boolean): { show: boolean; readOnly: boolean } {
  const demo = useDemo();
  return { show: isAdmin || demo, readOnly: demo };
}
