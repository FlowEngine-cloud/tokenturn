import { getPool, type Db } from "./db";
import { assertDay, displayLateral } from "./display";
import { ResolveError } from "./resolve";
import { fxExpr } from "./rollup";
import { getSetting } from "./settings";

/**
 * Tools page readers (spec 10 page 4): per tool and per person - spend
 * against the code still alive 30 days after it lands (the coding ROI,
 * spec 5), with accept and revert rates alongside as diagnostics.
 *
 * A "tool" is the AI authorship tag GitHub outcomes carry (bot authors +
 * co-author trailers, spec 5) - claude_code, cursor, copilot, devin, codex.
 * Three honest cost sources, each labeled and each drilling to its rows:
 *
 * - vendor:  the tool is what the vendor bills (Cursor, Copilot) - spend
 *            from the rollups per person, same as every chart.
 * - metric:  the vendor reports the tool's own estimated cost as a per-user
 *            counter (Claude Code's estimated_cost_cents, USD cents). Raw
 *            API dollars already sit under the key that ran them, so this
 *            is the only per-person Claude Code figure that exists - shown
 *            as the vendor's estimate, drilling to the usage_metrics rows.
 * - product: agents are products, not people (spec 7b) - a tool whose tag
 *            routes to a product (devin) costs what the product spent. No
 *            per-person split exists, and none is invented.
 *
 * Accept rates come from the vendors' own counters, computed at display
 * time, never stored (migration 004). No counter = no rate, shown as such.
 */

export interface ToolSpendSource {
  type: "vendor" | "metric" | "product";
  /** vendor/metric: the vendor whose rows back the number. */
  vendor?: string;
  metric?: string;
  /** product: the cost center the tool's tag routes to. */
  productId?: string;
  productName?: string;
}

export interface AcceptConfig {
  vendor: string;
  accepted: string;
  against: string;
  /** vs-rejected: rate = accepted/(accepted+against) - the counters are an
   * accepted/rejected pair. of-total: rate = accepted/against - the second
   * counter already counts every attempt. */
  mode: "vs-rejected" | "of-total";
}

interface ToolConfig {
  spend?:
    | { type: "vendor"; vendor: string }
    | { type: "metric"; vendor: string; metric: string };
  /** A vendor counter reporting the tool's tokens (Claude Code analytics). */
  tokensMetric?: { vendor: string; metric: string };
  accept?: AcceptConfig;
}

/** How each known tool's numbers are sourced - the one place that changes
 * when a connector starts reporting new counters. */
export const TOOL_SOURCES: Record<string, ToolConfig> = {
  claude_code: {
    spend: { type: "metric", vendor: "anthropic", metric: "estimated_cost_cents" },
    tokensMetric: { vendor: "anthropic", metric: "tokens" },
    accept: {
      vendor: "anthropic",
      accepted: "tool_actions_accepted",
      against: "tool_actions_rejected",
      mode: "vs-rejected",
    },
  },
  cursor: {
    spend: { type: "vendor", vendor: "cursor" },
    accept: { vendor: "cursor", accepted: "accepts", against: "rejects", mode: "vs-rejected" },
  },
  copilot: {
    spend: { type: "vendor", vendor: "github" },
    accept: {
      vendor: "github",
      accepted: "code_acceptances",
      against: "code_generations",
      mode: "of-total",
    },
  },
};

export interface ToolPersonRow {
  tool: string;
  /** null = no person: unmapped identities' counters and vendor spend in
   * the Unassigned bucket. Product-routed tool spend is NOT a person row -
   * it sits on the tool summary as product spend. */
  personId: string | null;
  name: string | null;
  email: string | null;
  /** null = this tool has no per-person cost source. */
  spendCents: number | null;
  /** Live merged PRs carrying this tool (reverted ones flipped out, spec 5). */
  merges: number;
  reverted: number;
  /** Line survival at the 30-day horizon over this person's checked PRs
   * (spec 5); rates stay null until the survival job has measured one. */
  linesWritten: number;
  linesAlive: number;
  survivalPct: number | null;
  costPer1kSurvivingCents: number | null;
  accepted: number | null;
  against: number | null;
  acceptRatePct: number | null;
}

export interface ToolSummary {
  tool: string;
  spendSource: ToolSpendSource | null;
  /** The vendor counters behind the accept rate - the drill's filter. */
  acceptSource: AcceptConfig | null;
  spendCents: number | null;
  /** Tokens behind the spend - rollup tokens (vendor/product-sourced) or the
   * vendor's own token counter (metric-sourced). 0 = the source reports none. */
  tokens: number;
  merges: number;
  reverted: number;
  acceptRatePct: number | null;
  /** reverted / (live + reverted), 1 decimal; null with no merges at all. */
  revertRatePct: number | null;
  /** Line survival (spec 5), from the survival job's git checks over this
   * tool's PRs merged in range. Written/alive are the 30-day horizon; null
   * rates = nothing checked yet, shown as a dash, never invented. */
  linesWritten: number;
  linesAlive: number;
  survivalPct: number | null;
  survival90Pct: number | null;
  /** Spend per 1,000 lines still alive at 30 days. */
  costPer1kSurvivingCents: number | null;
  /** People with any signal for this tool (spend, merges, or counters). */
  peopleCount: number;
}

export interface ToolsData {
  displayCurrency: string;
  from: string;
  to: string;
  tools: ToolSummary[];
  rows: ToolPersonRow[];
}

function acceptRate(
  accepted: number | null,
  against: number | null,
  mode: AcceptConfig["mode"],
): number | null {
  if (accepted === null || against === null) return null;
  const denominator = mode === "vs-rejected" ? accepted + against : against;
  if (denominator <= 0) return null;
  return Math.round((accepted / denominator) * 1000) / 10;
}

interface PersonSeed {
  personId: string | null;
  name: string | null;
  email: string | null;
}

type SurvivalAgg = { written: number; alive: number } | undefined;

/** The summary's survival block. 30 days is the headline horizon (it has
 * the most checked PRs); 90 days rides along for the drill page. Cost per
 * 1,000 surviving lines = the tool's range spend over the lines its
 * checked PRs kept alive at 30 days. */
function survivalFields(h30: SurvivalAgg, h90: SurvivalAgg, spendCents: number | null) {
  const pct = (agg: SurvivalAgg): number | null =>
    agg !== undefined && agg.written > 0
      ? Math.round((agg.alive / agg.written) * 1000) / 10
      : null;
  return {
    linesWritten: h30?.written ?? 0,
    linesAlive: h30?.alive ?? 0,
    survivalPct: pct(h30),
    survival90Pct: pct(h90),
    costPer1kSurvivingCents:
      spendCents !== null && h30 !== undefined && h30.alive > 0
        ? Math.round((spendCents / h30.alive) * 1000)
        : null,
  };
}

export async function toolsData(
  range: { from: string; to: string },
  db: Db = getPool(),
): Promise<ToolsData> {
  assertDay("from", range.from);
  assertDay("to", range.to);
  if (range.from > range.to) {
    throw new ResolveError(`from ${range.from} is after to ${range.to}`, 400);
  }
  const displayCurrency = await getSetting("display_currency", db);
  const fxMissing = new ResolveError(
    `no FX rate for the display currency ${displayCurrency} - sync FX rates first`,
    409,
  );

  const rowsByKey = new Map<string, ToolPersonRow>();
  const rowFor = (tool: string, seed: PersonSeed): ToolPersonRow => {
    const key = `${tool}\u0000${seed.personId ?? ""}`;
    let row = rowsByKey.get(key);
    if (!row) {
      row = {
        tool,
        ...seed,
        spendCents: null,
        merges: 0,
        reverted: 0,
        linesWritten: 0,
        linesAlive: 0,
        survivalPct: null,
        costPer1kSurvivingCents: null,
        accepted: null,
        against: null,
        acceptRatePct: null,
      };
      rowsByKey.set(key, row);
    }
    return row;
  };

  // Merged PRs per (tool, person): live counts on merge, a revert flips it
  // out (spec 5). Count-aware like every outcome total.
  const { rows: mergeRows } = await db.query(
    `SELECT t.tool, o.person_id AS "personId", p.name, p.email,
            COALESCE(SUM(o.count) FILTER (WHERE o.reverted_at IS NULL), 0)::int AS live,
            COALESCE(SUM(o.count) FILTER (WHERE o.reverted_at IS NOT NULL), 0)::int AS reverted
     FROM outcomes o
     CROSS JOIN LATERAL unnest(o.tools) AS t(tool)
     LEFT JOIN people p ON p.id = o.person_id
     WHERE o.kind = 'github_pr'
       AND (o.ts AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
     GROUP BY t.tool, o.person_id, p.name, p.email`,
    [range.from, range.to],
  );
  for (const row of mergeRows) {
    const cell = rowFor(row.tool, row);
    cell.merges = Number(row.live);
    cell.reverted = Number(row.reverted);
  }

  // The tools in play: whatever the merges carried plus every configured
  // tool - a tool with counters but no merged PR yet still shows up.
  const toolNames = new Set<string>([
    ...mergeRows.map((row) => row.tool as string),
    ...Object.keys(TOOL_SOURCES),
  ]);

  // Line survival per (tool, person, horizon) over the PRs merged in range -
  // only measured checks; unmeasurable PRs (error rows) stay absent (spec 5).
  // The 30-day horizon lands on the person rows; both horizons roll up per
  // tool for the summary.
  const { rows: survivalRows } = await db.query(
    `SELECT t.tool, o.person_id AS "personId", p.name, p.email,
            sc.horizon_days AS horizon,
            SUM(sc.lines_written)::bigint AS written,
            SUM(sc.lines_alive)::bigint AS alive
     FROM outcomes o
     CROSS JOIN LATERAL unnest(o.tools) AS t(tool)
     JOIN survival_checks sc
       ON sc.source_ref = o.source_ref AND sc.error IS NULL
     LEFT JOIN people p ON p.id = o.person_id
     WHERE o.kind = 'github_pr'
       AND (o.ts AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
     GROUP BY t.tool, o.person_id, p.name, p.email, sc.horizon_days`,
    [range.from, range.to],
  );
  const survivalByTool = new Map<string, { written: number; alive: number }>();
  for (const row of survivalRows) {
    const key = `${row.tool}:${row.horizon}`;
    const agg = survivalByTool.get(key) ?? { written: 0, alive: 0 };
    agg.written += Number(row.written);
    agg.alive += Number(row.alive);
    survivalByTool.set(key, agg);
    if (Number(row.horizon) === 30) {
      const cell = rowFor(row.tool, row);
      cell.linesWritten = Number(row.written);
      cell.linesAlive = Number(row.alive);
    }
  }

  const spendSources = new Map<string, ToolSpendSource>();
  const productSpend = new Map<string, number>();
  const tokensByTool = new Map<string, number>();

  for (const tool of toolNames) {
    const config = TOOL_SOURCES[tool];

    if (config?.spend?.type === "vendor") {
      spendSources.set(tool, { type: "vendor", vendor: config.spend.vendor });
      // Same rule as the People views: a person's rows plus the Unassigned
      // bucket; product-routed spend belongs to its product, not the tool's
      // person matrix.
      const { rows } = await db.query(
        `SELECT r.person_id AS "personId", p.name, p.email,
                ROUND(SUM(d.cents))::bigint AS cents,
                SUM(r.tokens)::bigint AS tokens,
                COALESCE(BOOL_OR(d.cents IS NULL), false) AS fx_missing
         FROM rollup_daily r
         LEFT JOIN people p ON p.id = r.person_id
         ${displayLateral("r")}
         WHERE r.day BETWEEN $2::date AND $3::date AND r.vendor = $4
           AND (r.person_id IS NOT NULL OR r.product_id IS NULL)
         GROUP BY r.person_id, p.name, p.email`,
        [displayCurrency, range.from, range.to, config.spend.vendor],
      );
      if (rows.some((row) => row.fx_missing)) throw fxMissing;
      for (const row of rows) {
        rowFor(tool, row).spendCents = Number(row.cents);
        tokensByTool.set(tool, (tokensByTool.get(tool) ?? 0) + Number(row.tokens));
      }
    } else if (config?.spend?.type === "metric") {
      spendSources.set(tool, {
        type: "metric",
        vendor: config.spend.vendor,
        metric: config.spend.metric,
      });
      // The vendor's own per-user estimate, reported in USD cents -
      // converted to the display currency at each day's rate.
      const { rows } = await db.query(
        `SELECT m.person_id AS "personId", p.name, p.email,
                ROUND(SUM(m.value / ${fxExpr("$1::text", "m.day")}))::bigint AS cents,
                COALESCE(BOOL_OR((${fxExpr("$1::text", "m.day")}) IS NULL), false)
                  AS fx_missing
         FROM usage_metrics m
         LEFT JOIN people p ON p.id = m.person_id
         WHERE m.day BETWEEN $2::date AND $3::date
           AND m.vendor = $4 AND m.metric = $5
         GROUP BY m.person_id, p.name, p.email`,
        [displayCurrency, range.from, range.to, config.spend.vendor, config.spend.metric],
      );
      if (rows.some((row) => row.fx_missing)) throw fxMissing;
      for (const row of rows) {
        rowFor(tool, row).spendCents = Number(row.cents);
      }
    } else {
      // No per-person cost source: agents are products (spec 7b). When the
      // tool's own tag routes to a product, the product's spend is the
      // tool's cost - summary-level, never split per person.
      const { rows } = await db.query(
        `SELECT ts.product_id AS "productId", pr.name,
                COALESCE(ROUND(SUM(d.cents)), 0)::bigint AS cents,
                COALESCE(SUM(r.tokens), 0)::bigint AS tokens,
                COALESCE(BOOL_OR(r.day IS NOT NULL AND d.cents IS NULL), false)
                  AS fx_missing
         FROM tag_settings ts
         JOIN products pr ON pr.id = ts.product_id
         LEFT JOIN rollup_daily r
           ON r.product_id = ts.product_id
          AND r.day BETWEEN $2::date AND $3::date
         LEFT JOIN LATERAL (
           SELECT r.amount_usd_cents::numeric / ${fxExpr("$1::text", "r.day")} AS cents
         ) d ON true
         WHERE ts.tag = $4 AND ts.product_id IS NOT NULL
         GROUP BY ts.product_id, pr.name`,
        [displayCurrency, range.from, range.to, tool],
      );
      if (rows.length > 0) {
        if (rows[0].fx_missing) throw fxMissing;
        spendSources.set(tool, {
          type: "product",
          productId: rows[0].productId,
          productName: rows[0].name,
        });
        productSpend.set(tool, Number(rows[0].cents));
        tokensByTool.set(tool, Number(rows[0].tokens));
      }
    }

    if (config?.tokensMetric) {
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(m.value), 0)::bigint AS tokens
         FROM usage_metrics m
         WHERE m.day BETWEEN $1::date AND $2::date
           AND m.vendor = $3 AND m.metric = $4`,
        [range.from, range.to, config.tokensMetric.vendor, config.tokensMetric.metric],
      );
      tokensByTool.set(tool, Number(rows[0].tokens));
    }

    if (config?.accept) {
      const { rows } = await db.query(
        `SELECT m.person_id AS "personId", p.name, p.email,
                COALESCE(SUM(m.value) FILTER (WHERE m.metric = $4), 0)::bigint AS accepted,
                COALESCE(SUM(m.value) FILTER (WHERE m.metric = $5), 0)::bigint AS against
         FROM usage_metrics m
         LEFT JOIN people p ON p.id = m.person_id
         WHERE m.day BETWEEN $1::date AND $2::date
           AND m.vendor = $3 AND m.metric IN ($4, $5)
         GROUP BY m.person_id, p.name, p.email`,
        [range.from, range.to, config.accept.vendor, config.accept.accepted, config.accept.against],
      );
      for (const row of rows) {
        const cell = rowFor(tool, row);
        cell.accepted = Number(row.accepted);
        cell.against = Number(row.against);
        cell.acceptRatePct = acceptRate(cell.accepted, cell.against, config.accept.mode);
      }
    }
  }

  const rows = [...rowsByKey.values()];
  for (const row of rows) {
    if (row.linesWritten > 0) {
      row.survivalPct = Math.round((row.linesAlive / row.linesWritten) * 1000) / 10;
    }
    if (row.spendCents !== null && row.linesAlive > 0) {
      row.costPer1kSurvivingCents = Math.round((row.spendCents / row.linesAlive) * 1000);
    }
  }

  const tools: ToolSummary[] = [];
  for (const tool of toolNames) {
    const cells = rows.filter((row) => row.tool === tool);
    const source = spendSources.get(tool) ?? null;
    const personSpendCells = cells.filter((cell) => cell.spendCents !== null);
    const spendCents =
      source?.type === "product"
        ? (productSpend.get(tool) ?? null)
        : personSpendCells.length > 0
          ? personSpendCells.reduce((sum, cell) => sum + (cell.spendCents ?? 0), 0)
          : null;
    const merges = cells.reduce((sum, cell) => sum + cell.merges, 0);
    const reverted = cells.reduce((sum, cell) => sum + cell.reverted, 0);
    if (cells.length === 0 && spendCents === null) continue; // no signal at all
    const counted = cells.filter((cell) => cell.accepted !== null);
    const accepted = counted.length
      ? counted.reduce((sum, cell) => sum + (cell.accepted ?? 0), 0)
      : null;
    const against = counted.length
      ? counted.reduce((sum, cell) => sum + (cell.against ?? 0), 0)
      : null;
    tools.push({
      tool,
      spendSource: source,
      acceptSource: TOOL_SOURCES[tool]?.accept ?? null,
      spendCents,
      tokens: tokensByTool.get(tool) ?? 0,
      merges,
      reverted,
      acceptRatePct: acceptRate(
        accepted,
        against,
        TOOL_SOURCES[tool]?.accept?.mode ?? "vs-rejected",
      ),
      revertRatePct:
        merges + reverted > 0
          ? Math.round((reverted / (merges + reverted)) * 1000) / 10
          : null,
      ...survivalFields(
        survivalByTool.get(`${tool}:30`),
        survivalByTool.get(`${tool}:90`),
        spendCents,
      ),
      peopleCount: cells.filter((cell) => cell.personId !== null).length,
    });
  }

  tools.sort(
    (a, b) =>
      (b.spendCents ?? -1) - (a.spendCents ?? -1) || a.tool.localeCompare(b.tool),
  );
  rows.sort(
    (a, b) =>
      a.tool.localeCompare(b.tool) ||
      (b.spendCents ?? -1) - (a.spendCents ?? -1) ||
      b.merges - a.merges ||
      (a.email ?? "￿").localeCompare(b.email ?? "￿"),
  );

  return { displayCurrency, from: range.from, to: range.to, tools, rows };
}
