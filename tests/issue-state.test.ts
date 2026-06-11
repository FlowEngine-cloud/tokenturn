import { describe, expect, it } from "vitest";
import {
  distillTransitions,
  evaluateIssue,
  windowDaysFrom,
  type StatusTransition,
} from "../src/lib/connectors/issues";

/**
 * The issue success state machine (spec 7), pure and clock-pinned: submitted
 * -> pending; success when the window passes without regression or Done
 * arrives sooner; fail on a regression inside the window. Shared by the Jira
 * and Linear connectors, so the matching rules are pinned once here.
 */

const NOW = new Date("2026-06-11T12:00:00Z");

function t(ts: string, name: string, bucket: StatusTransition["bucket"]): StatusTransition {
  return { ts, name, bucket };
}

describe("distillTransitions", () => {
  const flow = [
    t("2026-06-01T09:00:00Z", "To Do", "todo"),
    t("2026-06-02T09:00:00Z", "In Progress", "doing"),
    t("2026-06-05T09:00:00Z", "In Review", "doing"),
    t("2026-06-09T09:00:00Z", "Done", "done"),
  ];

  it("defaults: submitted = first in-progress status, regression = back to to-do", () => {
    expect(distillTransitions(flow)).toEqual({
      submittedAt: "2026-06-02T09:00:00.000Z",
      doneAt: "2026-06-09T09:00:00.000Z",
      regressedAt: null,
    });
    const bounced = [...flow.slice(0, 3), t("2026-06-06T09:00:00Z", "To Do", "todo")];
    expect(distillTransitions(bounced).regressedAt).toBe("2026-06-06T09:00:00.000Z");
  });

  it("a configured submitted status matches by name, case-insensitive", () => {
    expect(distillTransitions(flow, { submittedStatus: "in review" })).toMatchObject({
      submittedAt: "2026-06-05T09:00:00.000Z",
    });
  });

  it("a configured fail status only fails on that name - not any to-do status", () => {
    const bounced = [...flow.slice(0, 3), t("2026-06-06T09:00:00Z", "To Do", "todo")];
    expect(distillTransitions(bounced, { failStatus: "Rejected" }).regressedAt).toBeNull();
    const rejected = [...flow.slice(0, 3), t("2026-06-06T09:00:00Z", "Rejected", null)];
    expect(distillTransitions(rejected, { failStatus: "rejected" }).regressedAt).toBe(
      "2026-06-06T09:00:00.000Z",
    );
  });

  it("a status the vendor no longer defines (null bucket) never matches a default", () => {
    const ghost = [
      t("2026-06-02T09:00:00Z", "Old Review", null),
      t("2026-06-09T09:00:00Z", "Done", "done"),
    ];
    // Not submitted by default; the timeline anchors on Done instead.
    expect(distillTransitions(ghost)).toEqual({
      submittedAt: null,
      doneAt: "2026-06-09T09:00:00.000Z",
      regressedAt: null,
    });
  });

  it("regressions before the anchor (the initial To Do) never count", () => {
    expect(distillTransitions(flow).regressedAt).toBeNull();
  });

  it("unordered input and offset timestamps normalize to one UTC timeline", () => {
    const shuffled = [
      t("2026-06-09T11:00:00.000+0200", "Done", "done"),
      t("2026-06-02T09:00:00.000+0000", "In Progress", "doing"),
    ];
    expect(distillTransitions(shuffled)).toEqual({
      submittedAt: "2026-06-02T09:00:00.000Z",
      doneAt: "2026-06-09T09:00:00.000Z",
      regressedAt: null,
    });
  });
});

describe("evaluateIssue", () => {
  const submitted = "2026-06-02T09:00:00.000Z";

  it("submitted with an open window = pending", () => {
    expect(
      evaluateIssue({ submittedAt: submitted, doneAt: null, regressedAt: null }, 30, NOW),
    ).toEqual({
      status: "pending",
      anchorTs: submitted,
      windowEnd: "2026-07-02T09:00:00.000Z",
    });
  });

  it("reaching Done inside the window = success at the Done timestamp", () => {
    expect(
      evaluateIssue(
        { submittedAt: submitted, doneAt: "2026-06-09T10:15:00.000Z", regressedAt: null },
        30,
        NOW,
      ),
    ).toMatchObject({ status: "success", decidedAt: "2026-06-09T10:15:00.000Z" });
  });

  it("the window passing quietly = success at the window end, after the fact", () => {
    expect(
      evaluateIssue({ submittedAt: submitted, doneAt: null, regressedAt: null }, 5, NOW),
    ).toMatchObject({ status: "success", decidedAt: "2026-06-07T09:00:00.000Z" });
  });

  it("a regression inside the window = fail, even after a Done", () => {
    expect(
      evaluateIssue(
        {
          submittedAt: submitted,
          doneAt: "2026-06-05T09:00:00.000Z",
          regressedAt: "2026-06-10T09:00:00.000Z",
        },
        30,
        NOW,
      ),
    ).toMatchObject({ status: "fail", decidedAt: "2026-06-10T09:00:00.000Z" });
  });

  it("a regression after the window never flips - the success is final", () => {
    expect(
      evaluateIssue(
        {
          submittedAt: "2026-04-01T09:00:00.000Z",
          doneAt: "2026-04-03T09:00:00.000Z",
          regressedAt: "2026-05-20T09:00:00.000Z",
        },
        30,
        NOW,
      ),
    ).toMatchObject({ status: "success", decidedAt: "2026-04-03T09:00:00.000Z" });
  });

  it("straight to Done anchors there - the window becomes the reopen window", () => {
    expect(
      evaluateIssue(
        {
          submittedAt: null,
          doneAt: "2026-06-01T09:00:00.000Z",
          regressedAt: "2026-06-10T09:00:00.000Z",
        },
        30,
        NOW,
      ),
    ).toMatchObject({ status: "fail", anchorTs: "2026-06-01T09:00:00.000Z" });
  });

  it("no submitted, no Done = nothing to track", () => {
    expect(
      evaluateIssue({ submittedAt: null, doneAt: null, regressedAt: null }, 30, NOW),
    ).toEqual({ status: "none" });
  });
});

describe("windowDaysFrom", () => {
  it("reads the per-connection override and falls back to 30", () => {
    expect(windowDaysFrom({ windowDays: "10" })).toBe(10);
    expect(windowDaysFrom({})).toBe(30);
    expect(windowDaysFrom({ windowDays: "" })).toBe(30);
    expect(windowDaysFrom({ windowDays: "0" })).toBe(30);
    expect(windowDaysFrom({ windowDays: "soon" })).toBe(30);
  });
});
