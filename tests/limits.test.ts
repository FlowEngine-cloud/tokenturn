import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schedulerTick } from "../src/lib/connectors/scheduler";
import { clearConnectors } from "../src/lib/connectors/registry";
import { clearEventListeners, onEvent, type AppEvents } from "../src/lib/events";
import {
  checkAnomalies,
  checkLimitAlerts,
  listLimitStatus,
  monthStartDay,
  utcMonth,
} from "../src/lib/limits";
import { recomputeRollups } from "../src/lib/rollup";
import { setSetting } from "../src/lib/settings";
import { runMigrations } from "../scripts/migrate.mjs";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/**
 * Spec 9 burn alarms, driven over the real pipeline: people + spend_facts
 * -> recomputeRollups -> checkBurnAlerts, with pinned clocks. Every alert
 * asserts both the emitted event and the alert_state dedupe row.
 */

// Pinned "now"s. Facts are seeded on fixed days around these.
const MARCH = new Date("2026-03-20T12:00:00Z"); // month 2026-03, day 2026-03-20
const APRIL = new Date("2026-04-10T09:00:00Z");

describe.runIf(TEST_DATABASE_URL)("limits + burn alarms", () => {
  let dbUrl: string;
  let pool: Pool;
  let sourceRefCounter = 0;
  const limitEvents: AppEvents["limit.threshold"][] = [];
  const anomalyEvents: AppEvents["burn.anomaly"][] = [];

  async function makePerson(
    email: string,
    opts: { limitCents?: number | null; status?: string } = {},
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO people (email, name, status, monthly_limit_usd_cents)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [email, email.split("@")[0], opts.status ?? "active", opts.limitCents ?? null],
    );
    return rows[0].id;
  }

  async function addSpend(
    personId: string | null,
    day: string,
    amountCents: number,
    identityId: string | null = null,
  ): Promise<void> {
    sourceRefCounter += 1;
    await pool.query(
      `INSERT INTO spend_facts
         (day, person_id, vendor, amount_cents, currency, cost_basis,
          source_ref, identity_id)
       VALUES ($1, $2, 'testvendor', $3, 'USD', 'estimated', $4, $5)`,
      [day, personId, amountCents, `seed:${sourceRefCounter}`, identityId],
    );
    await recomputeRollups({ from: day, to: day }, pool);
  }

  beforeAll(async () => {
    dbUrl = await createScratchDb("limits_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    pool = new Pool({ connectionString: dbUrl, max: 5 });
    onEvent("limit.threshold", (p) => {
      limitEvents.push(p);
    });
    onEvent("burn.anomaly", (p) => {
      anomalyEvents.push(p);
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
    clearEventListeners();
    clearConnectors();
  });

  it("month helpers bucket by UTC", () => {
    expect(utcMonth(new Date("2026-03-31T23:59:59Z"))).toBe("2026-03");
    expect(utcMonth(new Date("2026-04-01T00:00:00Z"))).toBe("2026-04");
    expect(monthStartDay(MARCH)).toBe("2026-03-01");
  });

  describe("limit thresholds (calendar-month UTC, one alert per threshold per month)", () => {
    let dana: string;

    it("fires 80% once, with last month's spend excluded", async () => {
      dana = await makePerson("dana@acme.com", { limitCents: 50_000 });
      // February spend would be way past the limit - it must not count.
      await addSpend(dana, "2026-02-27", 90_000);
      await addSpend(dana, "2026-03-05", 20_000);
      await addSpend(dana, "2026-03-10", 21_210); // MTD 41,210 = 82.4%

      const fired = await checkLimitAlerts({ pool, now: MARCH });
      expect(fired).toEqual([
        {
          personId: dana,
          email: "dana@acme.com",
          name: "dana",
          month: "2026-03",
          thresholdPct: 80,
          limitUsdCents: 50_000,
          monthSpendUsdCents: 41_210,
        },
      ]);
      expect(limitEvents).toEqual(fired);

      // Deduped: nothing more this month at the same threshold.
      expect(await checkLimitAlerts({ pool, now: MARCH })).toEqual([]);
      const { rows } = await pool.query(
        "SELECT kind, scope, period_key FROM alert_state WHERE kind LIKE 'limit%' ORDER BY kind",
      );
      expect(rows).toEqual([{ kind: "limit_80", scope: dana, period_key: "2026-03" }]);
    });

    it("crossing 100% later fires the 100 alert exactly once", async () => {
      await addSpend(dana, "2026-03-15", 10_000); // MTD 51,210 = 102.4%
      const fired = await checkLimitAlerts({ pool, now: MARCH });
      expect(fired.map((f) => f.thresholdPct)).toEqual([100]);
      expect(fired[0].monthSpendUsdCents).toBe(51_210);
      expect(await checkLimitAlerts({ pool, now: MARCH })).toEqual([]);
    });

    it("the next month starts clean and can fire again", async () => {
      expect(await checkLimitAlerts({ pool, now: APRIL })).toEqual([]);
      await addSpend(dana, "2026-04-03", 45_000); // April MTD 90%
      const fired = await checkLimitAlerts({ pool, now: APRIL });
      expect(fired).toMatchObject([
        { personId: dana, month: "2026-04", thresholdPct: 80, monthSpendUsdCents: 45_000 },
      ]);
    });

    it("jumping straight past 100% fires every crossed threshold", async () => {
      const eli = await makePerson("eli@acme.com", { limitCents: 10_000 });
      await addSpend(eli, "2026-03-08", 12_000);
      const fired = await checkLimitAlerts({ pool, now: MARCH });
      expect(fired.map((f) => `${f.thresholdPct}`)).toEqual(["80", "100"]);
      expect(fired.every((f) => f.personId === eli)).toBe(true);
    });

    it("people without a limit and offboarded people never alert", async () => {
      const noLimit = await makePerson("nolimit@acme.com");
      const gone = await makePerson("gone@acme.com", {
        limitCents: 1_000,
        status: "offboarded",
      });
      await addSpend(noLimit, "2026-03-09", 500_000);
      await addSpend(gone, "2026-03-09", 500_000);
      expect(await checkLimitAlerts({ pool, now: MARCH })).toEqual([]);
    });

    it("spend whose tag is toggled off personal usage does not count", async () => {
      const fay = await makePerson("fay@acme.com", { limitCents: 10_000 });
      const { rows } = await pool.query(
        `INSERT INTO identities (person_id, vendor, external_id, kind, tags, email)
         VALUES ($1, 'testvendor', 'batch-key-1', 'api_key', '{batch}', 'fay@acme.com')
         RETURNING id`,
        [fay],
      );
      await pool.query(
        "INSERT INTO tag_settings (tag, counts_personal) VALUES ('batch', false)",
      );
      await addSpend(fay, "2026-03-12", 20_000, rows[0].id); // batch: excluded
      await addSpend(fay, "2026-03-12", 1_000); // personal: counts
      expect(await checkLimitAlerts({ pool, now: MARCH })).toEqual([]);
    });

    it("thresholds are settings-editable (one alert per configured threshold)", async () => {
      await setSetting("limit_alert_thresholds_pct", [50], pool);
      const kim = await makePerson("kim@acme.com", { limitCents: 10_000 });
      await addSpend(kim, "2026-03-14", 5_000);
      // A new threshold is a new dedupe key, so everyone over 50% fires at
      // 50 - including people already alerted at 80/100 this month.
      const fired = await checkLimitAlerts({ pool, now: MARCH });
      expect(fired.every((f) => f.thresholdPct === 50)).toBe(true);
      expect(fired.map((f) => f.personId)).toContain(kim);
      const { rows } = await pool.query(
        "SELECT kind FROM alert_state WHERE scope = $1",
        [kim],
      );
      expect(rows).toEqual([{ kind: "limit_50" }]);
      await setSetting("limit_alert_thresholds_pct", [80, 100], pool);
    });
  });

  describe("anomaly alarms (>= multiplier x trailing 30-day avg AND >= floor, one per person per day)", () => {
    it("fires once on a 3x day over the floor, then again the next day", async () => {
      const gil = await makePerson("gil@acme.com");
      // Trailing window for 2026-03-20 is 2026-02-18..2026-03-19.
      await addSpend(gil, "2026-03-01", 35_400); // avg 1,180/day
      await addSpend(gil, "2026-03-20", 6_140); // 5.2x avg, >= $20

      const fired = await checkAnomalies({ pool, now: MARCH });
      expect(fired).toEqual([
        {
          personId: gil,
          email: "gil@acme.com",
          name: "gil",
          day: "2026-03-20",
          dayUsdCents: 6_140,
          trailingAvgUsdCents: 1_180,
          multiplier: 3,
          minDayUsdCents: 2_000,
        },
      ]);
      expect(anomalyEvents).toEqual(fired);
      // Max one per person per day.
      expect(await checkAnomalies({ pool, now: MARCH })).toEqual([]);
      const { rows } = await pool.query(
        "SELECT period_key FROM alert_state WHERE kind = 'anomaly' AND scope = $1",
        [gil],
      );
      expect(rows).toEqual([{ period_key: "2026-03-20" }]);

      // The next day is a fresh period; yesterday's spike joins the average.
      await addSpend(gil, "2026-03-21", 21_000);
      const nextDay = new Date("2026-03-21T18:00:00Z");
      const again = await checkAnomalies({ pool, now: nextDay });
      expect(again).toMatchObject([
        {
          personId: gil,
          day: "2026-03-21",
          dayUsdCents: 21_000,
          trailingAvgUsdCents: Math.round((35_400 + 6_140) / 30),
        },
      ]);
    });

    it("a day under the $20 floor never alarms, even at infinite-x", async () => {
      const hila = await makePerson("hila@acme.com");
      await addSpend(hila, "2026-03-20", 1_900);
      expect(await checkAnomalies({ pool, now: MARCH })).toEqual([]);
    });

    it("a big day under the multiplier never alarms", async () => {
      const ido = await makePerson("ido@acme.com");
      await addSpend(ido, "2026-03-10", 150_000); // avg $50/day
      await addSpend(ido, "2026-03-20", 6_000); // $60 < 3 x $50
      expect(await checkAnomalies({ pool, now: MARCH })).toEqual([]);
    });

    it("no history + a day over the floor alarms (avg 0)", async () => {
      const jon = await makePerson("jon@acme.com");
      await addSpend(jon, "2026-03-20", 2_500);
      const fired = await checkAnomalies({ pool, now: MARCH });
      expect(fired).toMatchObject([
        { personId: jon, dayUsdCents: 2_500, trailingAvgUsdCents: 0 },
      ]);
    });

    it("multiplier and floor are settings-editable", async () => {
      // A day of its own (2026-03-25) so only lea is in the today bucket.
      const now25 = new Date("2026-03-25T15:00:00Z");
      await setSetting("anomaly_burn_multiplier", 10, pool);
      await setSetting("anomaly_min_day_cents", 100, pool);
      const lea = await makePerson("lea@acme.com");
      await addSpend(lea, "2026-03-02", 30_000); // avg 1,000/day
      await addSpend(lea, "2026-03-25", 5_000); // 5x: under 10x, over the floor
      expect(await checkAnomalies({ pool, now: now25 })).toEqual([]);

      await setSetting("anomaly_burn_multiplier", 3, pool);
      const fired = await checkAnomalies({ pool, now: now25 });
      expect(fired).toMatchObject([
        { personId: lea, dayUsdCents: 5_000, multiplier: 3, minDayUsdCents: 100 },
      ]);
      await setSetting("anomaly_min_day_cents", 2_000, pool);
    });

    it("offboarded people never alarm", async () => {
      const max = await makePerson("max@acme.com", { status: "offboarded" });
      await addSpend(max, "2026-03-20", 50_000);
      expect(await checkAnomalies({ pool, now: MARCH })).toEqual([]);
    });
  });

  it("the scheduler tick runs both checks", async () => {
    const mia = await makePerson("mia@acme.com", { limitCents: 1_000 });
    await addSpend(mia, "2026-05-02", 5_000);
    const tickNow = new Date("2026-05-02T08:00:00Z");
    const result = await schedulerTick({ pool, now: tickNow });
    expect(result.burn.limitAlerts.map((f) => `${f.personId}:${f.thresholdPct}`)).toEqual(
      [`${mia}:80`, `${mia}:100`],
    );
    expect(result.burn.anomalies).toMatchObject([
      { personId: mia, day: "2026-05-02", dayUsdCents: 5_000 },
    ]);
  });

  it("listLimitStatus shows our limit, MTD spend, fired thresholds, and the vendor's limit next to ours", async () => {
    // The vendor-reported Cursor limit: an older cycle and the current one.
    const dana = (
      await pool.query("SELECT id FROM people WHERE email = 'dana@acme.com'")
    ).rows[0].id;
    await pool.query(
      `INSERT INTO usage_metrics (day, vendor, metric, value, person_id, source_ref)
       VALUES ('2026-02-01', 'cursor', 'spend_limit_dollars', 300, $1, 'spend:2026-02-01:42'),
              ('2026-03-01', 'cursor', 'spend_limit_dollars', 500, $1, 'spend:2026-03-01:42')`,
      [dana],
    );

    const page = await listLimitStatus(pool, MARCH);
    expect(page.month).toBe("2026-03");
    expect(page.from).toBe("2026-03-01");
    expect(page.to).toBe("2026-03-20");

    const danaRow = page.people.find((p) => p.email === "dana@acme.com")!;
    expect(danaRow).toMatchObject({
      limitUsdCents: 50_000,
      monthSpendUsdCents: 51_210,
      // 50 fired during the editable-thresholds test - the dedupe state is
      // honest about everything that alerted this month.
      thresholdsFired: [50, 80, 100],
      vendorLimits: [
        {
          vendor: "cursor",
          limitUsdCents: 50_000, // the LATEST vendor row ($500), drillable
          asOfDay: "2026-03-01",
          sourceRef: "spend:2026-03-01:42",
        },
      ],
    });

    // Active people only; never pretend to hard-stop what we can't.
    expect(page.people.find((p) => p.email === "gone@acme.com")).toBeUndefined();
    expect(page.vendorPolicies.openai.enforcement).toBe("alert-only");
    expect(page.vendorPolicies.anthropic.canWrite).toBe(false);
    expect(page.vendorPolicies.cursor.canWrite).toBe(true);

    // No-limit people are listed (so limits can be set), with limit null.
    const noLimitRow = page.people.find((p) => p.email === "nolimit@acme.com")!;
    expect(noLimitRow.limitUsdCents).toBeNull();
    expect(noLimitRow.monthSpendUsdCents).toBe(500_000);
  });
});
