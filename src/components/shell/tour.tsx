"use client";

import { driver, type Driver } from "driver.js";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import "driver.js/dist/driver.css";

/**
 * The product tour (a thin wrapper over driver.js). One controller mounted in
 * the dashboard layout - which never unmounts as you move between dashboard
 * pages, so it can walk you across them: each step names the route its element
 * lives on, and the controller navigates there, waits for the element, then
 * pops the bubble. Casual copy, on purpose.
 *
 * Fires once for a fresh admin (the moment onboarding flips to "done"), and
 * on demand from the "Replay tour" button in Help. The "seen" flag is the
 * only state we keep - everything else lives in refs that survive navigation.
 */

const SEEN_KEY = "ai-pnl:tour-seen";
/** Help's button asks for a replay; onboarding announces it just finished. */
export const START_TOUR_EVENT = "ai-pnl:start-tour";
export const ONBOARDING_DONE_EVENT = "ai-pnl:onboarding-done";

interface TourStep {
  /** Pathname the element lives on (no query). */
  path: string;
  /** Query params that must be set for this step (e.g. the settings tab). */
  query?: Record<string, string>;
  /** CSS selector to spotlight; omit for a centered, anchorless bubble. */
  element?: string;
  popover: {
    title: string;
    description: string;
    side?: "top" | "right" | "bottom" | "left";
    align?: "start" | "center" | "end";
  };
}

/** Built fresh on each run - `{id}` person steps only exist if a person does. */
function buildSteps(personId: string | null): TourStep[] {
  const steps: TourStep[] = [
    {
      path: "/",
      popover: {
        title: "Welcome to TurnToken 👋",
        description:
          "TurnToken turns your AI bills into who-spent-what - every token, in real dollars, per person and per product.<br><br>30-second tour?",
      },
    },
    {
      path: "/",
      element: '[data-tour="overview-total"]',
      popover: {
        title: "Every AI dollar, one number",
        description:
          "Your whole org's AI spend, live. Click any number on any page to drill straight to the raw vendor rows behind it.",
        side: "bottom",
        align: "start",
      },
    },
    {
      path: "/people",
      element: '[data-tour="people-add"]',
      popover: {
        title: "Bring your team in",
        description:
          "Three ways: add someone by hand, import a CSV, or sync <b>Okta / Google Workspace</b> (Enterprise). Identities auto-match by email across vendors.",
        side: "bottom",
        align: "end",
      },
    },
  ];

  if (personId) {
    steps.push(
      {
        path: `/people/${personId}`,
        element: '[data-tour="person-limit"]',
        popover: {
          title: "Set a spend limit",
          description:
            "Cap anyone's monthly spend. They (and you) get pinged at 80% and 100% - no surprise invoices.",
          side: "bottom",
          align: "start",
        },
      },
      {
        path: `/people/${personId}`,
        element: '[data-tour="person-offboard"]',
        popover: {
          title: "Offboard in one click",
          description:
            "Someone leaving? This pulls every key and seat across every vendor at once. Their history stays intact.",
          side: "bottom",
          align: "end",
        },
      },
    );
  }

  steps.push(
    {
      path: "/roi",
      element: '[data-tour="roi-add"]',
      popover: {
        title: "Prove it was worth it",
        description:
          "An ROI pairs a slice of spend with a result you define. A few ways people use it:<br><br>• $ per merged PR for Copilot<br>• $ per resolved ticket for a support bot<br>• $ per 1k lines of code still alive 30 days later<br><br>Add your own here.",
        side: "bottom",
        align: "end",
      },
    },
    {
      path: "/settings",
      query: { tab: "connections" },
      element: '[data-tour="settings-tab-connections"]',
      popover: {
        title: "This is where the numbers come from",
        description:
          "Plug in Anthropic, OpenAI, Cursor, Copilot and more. No proxy, nothing in your request path - it just reads what they already bill you.",
        side: "bottom",
        align: "start",
      },
    },
    {
      path: "/settings",
      query: { tab: "alerts" },
      element: '[data-tour="settings-tab-alerts"]',
      popover: {
        title: "Alerts, your way",
        description:
          "Pick the thresholds and who hears about them - Slack and email. Plus a burn alarm when someone's daily spend spikes.",
        side: "bottom",
        align: "start",
      },
    },
    {
      path: "/help",
      element: '[data-tour="nav-help"]',
      popover: {
        title: "That's the tour 🎉",
        description:
          "Everything in one place. Want a refresher later? Replay this from Help anytime.",
        side: "right",
        align: "center",
      },
    },
  );

  return steps;
}

/** Resolve the selector, retrying across a few frames while the page settles. */
function waitForElement(selector: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      if (document.querySelector(selector)) return resolve(true);
      if (performance.now() - start > timeoutMs) return resolve(false);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export function Tour() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const driverRef = useRef<Driver | null>(null);
  const stepsRef = useRef<TourStep[]>([]);
  const indexRef = useRef(0);
  // Set while a step's route differs from the current one: the page-change
  // effect picks it up and resumes there.
  const pendingRef = useRef<number | null>(null);

  const onThisRoute = useCallback(
    (step: TourStep): boolean => {
      if (step.path !== pathname) return false;
      if (step.query) {
        for (const [k, v] of Object.entries(step.query)) {
          if (searchParams.get(k) !== v) return false;
        }
      }
      return true;
    },
    [pathname, searchParams],
  );

  const teardown = useCallback(() => {
    driverRef.current?.destroy();
    driverRef.current = null;
  }, []);

  const finish = useCallback(() => {
    pendingRef.current = null;
    teardown();
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* private mode - the tour simply may reappear */
    }
  }, [teardown]);

  // Forward declaration so onNext/onPrev can reach renderStep.
  const renderStepRef = useRef<(index: number) => void>(() => {});

  const showStep = useCallback(
    async (index: number) => {
      const step = stepsRef.current[index];
      if (!step) return finish();
      if (step.element) {
        const found = await waitForElement(step.element);
        // The anchor never showed (e.g. an admin-only button) - skip ahead
        // rather than spotlighting nothing.
        if (!found) return renderStepRef.current(index + 1);
      }
      indexRef.current = index;
      teardown();
      driverRef.current = driver({
        showProgress: true,
        allowClose: true,
        // No dimmed/blurred backdrop - the page stays fully visible, the bubble
        // just points at the element.
        overlayOpacity: 0,
        stagePadding: 6,
        nextBtnText: index === stepsRef.current.length - 1 ? "Done" : "Next →",
        prevBtnText: "← Back",
        steps: stepsRef.current.map((s) => ({
          element: s.element,
          popover: s.popover,
        })),
        onNextClick: () => renderStepRef.current(indexRef.current + 1),
        onPrevClick: () => renderStepRef.current(indexRef.current - 1),
        onCloseClick: finish,
      });
      driverRef.current.drive(index);
    },
    [finish, teardown],
  );

  const renderStep = useCallback(
    (index: number) => {
      if (index >= stepsRef.current.length) return finish();
      const clamped = Math.max(0, index);
      const step = stepsRef.current[clamped];
      if (onThisRoute(step)) {
        pendingRef.current = null;
        void showStep(clamped);
        return;
      }
      // Wrong page: tear the bubble down, navigate, let the route effect resume.
      pendingRef.current = clamped;
      teardown();
      const qs = step.query ? `?${new URLSearchParams(step.query)}` : "";
      router.push(`${step.path}${qs}`);
    },
    [finish, onThisRoute, router, showStep, teardown],
  );

  useEffect(() => {
    renderStepRef.current = renderStep;
  }, [renderStep]);

  const start = useCallback(async () => {
    if (driverRef.current) return; // already running
    let personId: string | null = null;
    try {
      const res = await fetch("/api/people");
      if (res.ok) {
        const data = await res.json();
        const rows: Array<{ personId: string | null }> = data?.people ?? [];
        personId = rows.find((r) => r.personId !== null)?.personId ?? null;
      }
    } catch {
      /* no roster yet - the person steps just drop out */
    }
    stepsRef.current = buildSteps(personId);
    renderStep(0);
  }, [renderStep]);

  // Resume on the page we just navigated to for a step.
  useEffect(() => {
    const target = pendingRef.current;
    if (target === null) return;
    const step = stepsRef.current[target];
    if (step && onThisRoute(step)) {
      pendingRef.current = null;
      void showStep(target);
    }
  }, [onThisRoute, showStep]);

  // Triggers: manual replay (Help), and the one-shot first run.
  useEffect(() => {
    const onStart = () => void start();
    const onDone = () => {
      try {
        if (localStorage.getItem(SEEN_KEY)) return;
      } catch {
        /* ignore */
      }
      void start();
    };
    window.addEventListener(START_TOUR_EVENT, onStart);
    window.addEventListener(ONBOARDING_DONE_EVENT, onDone);
    return () => {
      window.removeEventListener(START_TOUR_EVENT, onStart);
      window.removeEventListener(ONBOARDING_DONE_EVENT, onDone);
    };
  }, [start]);

  // First-run auto-start: a fresh admin who lands on a "done" instance and has
  // never seen the tour. Runs once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (localStorage.getItem(SEEN_KEY)) return;
      } catch {
        return;
      }
      try {
        const [stateRes, authRes] = await Promise.all([
          fetch("/api/onboarding"),
          fetch("/api/auth/state"),
        ]);
        if (!stateRes.ok || !authRes.ok) return;
        const state = await stateRes.json();
        const auth = await authRes.json();
        if (cancelled) return;
        if (state?.stage === "done" && auth?.user?.role === "admin") {
          void start();
        }
      } catch {
        /* offline / first paint - replay from Help still works */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop the tour if the controller ever unmounts (e.g. logout).
  useEffect(() => teardown, [teardown]);

  return null;
}
