import type { Metadata } from "next";
import Link from "next/link";
import { Block, Code, Section } from "../section";

export const metadata: Metadata = { title: "API reference - AI P&L" };

/** The full endpoint list (spec 10 help, grown in place): every number in the
 * dashboard comes from these routes - the UI has no private data path. Facts
 * here mirror the route docstrings; when they disagree, the route wins. */

function Ep({ sig, admin, children }: { sig: string; admin?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="font-mono text-sm text-foreground">
        {sig}
        {admin && <span className="ml-2 font-sans text-xs text-muted-foreground">admin</span>}
      </p>
      <p>{children}</p>
    </div>
  );
}

export default function ApiReferencePage() {
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <h1 className="text-lg font-semibold">API reference</h1>

      <Section title="Auth">
        <p>
          The dashboard&apos;s own endpoints use the login session cookie: every
          logged-in user can read, only the admin can write (marked{" "}
          <span className="text-foreground">admin</span> below). The one endpoint meant
          for your systems is <Code>POST /api/ingest</Code>, authenticated by a Bearer{" "}
          <span className="text-foreground">ingest key</span> minted in Settings.
          Dates are <Code>YYYY-MM-DD</Code>; money travels as integer cents.
        </p>
      </Section>

      <Section title="Ingest - the integration endpoint">
        <Ep sig="POST /api/ingest">
          Bearer ingest key. Body <Code>{`{"events": [...]}`}</Code> - up to 500 events,
          1 MB, 600 requests per key per minute. Each event answers with its own
          verdict - <Code>accepted</Code> / <Code>duplicate</Code> /{" "}
          <Code>rejected</Code> plus the reason verbatim - so one bad event never sinks
          a batch. Events carry your UUID and the server upserts on it: retries never
          double-count.
        </Ep>
        <p>
          A <span className="text-foreground">call event</span> (spend; the ROI
          needs attribution <Code>sdk</Code>) prices tokens from the same pinned table
          as the connectors:
        </p>
        <Block>
          {`{"id": "<uuid>", "kind": "call", "ts": "<ISO>", "vendor": "openai" | "anthropic",
 "model": "gpt-4o-mini", "inputTokens": 1200, "outputTokens": 340,
 "employee": "dana@acme.com"?}`}
        </Block>
        <p>
          An <span className="text-foreground">outcome event</span> (success; the
          ROI needs outcome kind <Code>sdk_event</Code>). <Code>ref</Code> is the
          real record the number drills to; re-tracking the same ref restates it in
          place. <Code>currency</Code> is required with <Code>valueCents</Code>:
        </p>
        <Block>
          {`{"id": "<uuid>", "kind": "outcome", "ts": "<ISO>", "outcome": "coupon_created",
 "valueCents": 4000?, "currency": "USD"?, "ref": "SUMMER20"?,
 "employee": "dana@acme.com"?}`}
        </Block>
        <p>
          <Code>employee</Code> runs the standard identity machinery: auto-match by
          email, the Resolve queue when unknown, full-history re-attribution on a later
          match.
        </p>
        <Ep sig="GET /api/ingest-keys">Lists keys - prefixes only, never tokens.</Ep>
        <Ep sig="POST /api/ingest-keys" admin>
          Mints a key scoped to one ROI. The token is in this response and nowhere
          else - shown exactly once.
        </Ep>
        <Ep sig={'PATCH /api/ingest-keys/{id} {"revoked": true}'} admin>
          The permanent kill switch.
        </Ep>
      </Section>

      <Section title="Read the ledger">
        <Ep sig="GET /api/overview?from&to">
          Total spend with the estimated/invoiced split, attribution coverage with the
          Unassigned remainder, daily trend, spend by vendor, top people and ROI,
          connector health.
        </Ep>
        <Ep sig="GET /api/roi?from&to">
          Every ROI calculation over the range in one list - spend, tokens, successes,
          $ and tokens per success, value, and the multiple.
        </Ep>
        <Ep sig="GET /api/facts?from&to&day&vendor&person&product&key&model&basis">
          Raw spend facts. Totals cover the whole filter, so a drill provably sums to
          its tile; every row carries the vendor <Code>source_ref</Code>.
        </Ep>
        <Ep sig="GET /api/outcomes?from&to&person&product&kind&tool">
          Raw outcomes, count-aware, with the live/reverted split and AI authorship
          tags.
        </Ep>
        <Ep sig="GET /api/metrics?from&to&vendor&metric&person&key">
          Raw usage counters; <Code>metric</Code> takes a comma list, so an accept
          rate&apos;s two inputs land on one page.
        </Ep>
        <Ep sig="GET /api/runs?vendor">Sync history per connector.</Ep>
        <Ep sig="GET /api/search?q=">Cmd-K: people, ROI, vendors, pages.</Ep>
        <Ep sig="GET /api/limits">
          Our limit next to the vendor&apos;s own, with what each vendor can actually
          enforce stated verbatim.
        </Ep>
        <Ep sig="GET /api/version">
          Running version; checks GitHub releases only when the off-by-default setting
          is on.
        </Ep>
        <Ep sig="GET /healthz">
          Public. <Code>200</Code> when app and database are up, <Code>503</Code>{" "}
          otherwise.
        </Ep>
      </Section>

      <Section title="People">
        <Ep sig="GET /api/people?from&to">
          Everyone plus the Unassigned bucket - spend by vendor, live outcomes,
          $/outcome, daily trend.
        </Ep>
        <Ep sig="GET /api/people/{id}?from&to">
          One person - daily breakdown per vendor, keys and seats with tags and
          all-time last use, ROI touched, outcomes by kind. Follows merges to the
          surviving person.
        </Ep>
        <Ep sig="GET /api/keys/{id}">
          A key&apos;s all-time profile: tags with routing, owner, ROI, per-model
          spend, last used.
        </Ep>
        <Ep sig="POST /api/people" admin>
          Add one person - same upsert and auto-match sweep as the CSV; the CSV is this
          in bulk.
        </Ep>
        <Ep sig="POST /api/people/import?preview=1" admin>
          CSV body, headers auto-detect (email required). <Code>preview=1</Code>{" "}
          returns per-row verdicts without committing; a commit is all-or-nothing.
          Re-import upserts by email, never removes anyone.
        </Ep>
        <Ep sig={'POST /api/people/invite {"personIds": [...], "vendors": [...]}'} admin>
          Invite fan-out - every (person, vendor) pair gets its own result, one vendor
          failing never blocks the rest.
        </Ep>
        <Ep sig={'POST /api/people/{id}/keys {"vendor": "openai", "projectId"?}'} admin>
          Mints an OpenAI key for the person. The key value is in this response exactly
          once - never stored, never logged. Anthropic has no key-creation API; keys
          people mint themselves auto-map on the next sync.
        </Ep>
        <Ep sig={'PUT /api/people/{id}/limit {"limitUsdCents": 50000}'} admin>
          Monthly alert limit; <Code>null</Code> clears. An alert, never a hard stop.
        </Ep>
        <Ep sig="GET | POST /api/people/{id}/offboard" admin>
          <Code>GET</Code> is the plan - every key and seat across every vendor;{" "}
          <Code>POST</Code> is the sweep. Failed items keep the vendor&apos;s error
          verbatim and retry one by one via{" "}
          <Code>{`POST .../offboard/retry {"itemId"}`}</Code>. History survives.
        </Ep>
        <Ep sig="DELETE /api/people/{id}" admin>
          Removes the person and scrubs their personal data; their spend stays on the
          ledger as Unassigned, so no total ever changes. Irreversible.
        </Ep>
      </Section>

      <Section title="ROI">
        <Ep sig="GET /api/products">Every ROI row with rollup-backed totals.</Ep>
        <Ep sig="GET /api/products/view?from&to">
          Each ROI row&apos;s own metric in its own unit, plus the multiple
          where real value exists.
        </Ep>
        <Ep sig="GET /api/products/{id}?from&to">
          Spend by basis, vendor, person, and day; outcomes by kind; unit cost, value,
          ROI; the keys routed to it; manual entries.
        </Ep>
        <Ep sig="POST /api/products | PATCH /api/products/{id}" admin>
          Create and change. Archive (<Code>{`"archived": true`}</Code>) is the only
          exit - history stays fully readable. <Code>defaultValueCents</Code> re-values
          unvalued outcomes at read time.
        </Ep>
        <Ep sig="PUT /api/products/{id}/manual" admin>
          Monthly cost or outcome entries for tools with no API - one entry per
          ROI, kind, and month; a PUT for the same month rewrites it in place.
        </Ep>
      </Section>

      <Section title="Tags">
        <Ep sig="GET /api/tags">Every tag in use with the keys and spend behind it.</Ep>
        <Ep sig="GET /api/tags/{tag}">
          The ledger filtered by tag, across all employees and keys, down to vendor
          rows.
        </Ep>
        <Ep sig={'POST /api/tags {"tag": "devin"}'} admin>
          Add a tag ahead of its keys - name a key with it in the vendor console and
          its spend lands under it on next sync. Idempotent.
        </Ep>
        <Ep sig={'PATCH /api/tags/{tag} {"countsPersonal"?, "productId"?}'} admin>
          <Code>countsPersonal: false</Code> flags spend out of personal numbers;{" "}
          <Code>productId</Code> routes every key carrying the tag to an ROI,
          re-attributing full history.
        </Ep>
      </Section>

      <Section title="Resolve">
        <Ep sig="GET /api/resolve">
          The identity queue with explainable suggestions, plus tag conflicts.
        </Ep>
        <Ep sig="POST /api/resolve/{id}/confirm" admin>
          Matches an identity to a person, re-attributes its full history, and is
          remembered forever.
        </Ep>
        <Ep sig="POST /api/resolve/{id}/not-person" admin>
          A service account: routes to an ROI and/or tag; auto-match never re-fills
          it.
        </Ep>
        <Ep sig="POST /api/resolve/merge" admin>
          Two emails, one human - identities, history, and email follow the survivor.
        </Ep>
      </Section>

      <Section title="Connectors">
        <Ep sig="GET /api/connectors">
          Health: last sync, row counts, the vendor&apos;s error verbatim.
        </Ep>
        <Ep sig="POST /api/connectors/{vendor}/connect" admin>
          Validates token scopes on connect; credentials stored encrypted, never read
          back.
        </Ep>
        <Ep sig="POST /api/connectors/{vendor}/sync" admin>Sync now.</Ep>
        <Ep sig="GET | DELETE /api/connectors/{vendor}" admin>
          Connector detail; <Code>DELETE</Code> disconnects (synced history stays).
        </Ep>
      </Section>

      <Section title="Report and money">
        <Ep sig="GET /api/report?month=YYYY-MM">
          The CFO month: spend by ROI and by person with month-over-month, unit costs, ROI
          where defined, six-month trend. Always sums to the whole ledger.
        </Ep>
        <Ep sig="GET /api/report/csv?month=">The same table as CSV.</Ep>
        <Ep sig="GET /api/report/focus?month=">
          A FOCUS 1.4 export - one row per raw spend fact, for any FinOps tool.
        </Ep>
        <Ep sig="GET /api/invoices">
          The drift report: estimated vs invoiced facts vs the invoice, per
          vendor-month.
        </Ep>
        <Ep sig="POST /api/invoices/import?preview=1" admin>
          CSV body (<Code>vendor, month, amount, currency</Code> + optional ref and
          note). Only completed months; re-import corrects in place.
        </Ep>
        <Ep sig="GET /api/fx | POST /api/fx/sync (admin)">
          Daily ECB rate coverage; <Code>POST</Code> fetches now.
        </Ep>
      </Section>

      <Section title="Admin">
        <Ep sig="GET | PATCH /api/settings (PATCH admin)">
          Everything configurable - thresholds, display currency, Slack webhook, email
          provider. Secrets are stored encrypted and never echoed back;{" "}
          <Code>null</Code> clears them.
        </Ep>
        <Ep sig="GET | POST /api/users, DELETE /api/users/{id}" admin>
          View-only users (username + password). The one admin is whoever claimed the
          instance.
        </Ep>
        <Ep sig={'POST /api/email/test {"to": ...}'} admin>
          Sends through the configured provider and returns its rejection verbatim.
        </Ep>
        <Ep sig="POST /api/demo" admin>
          Loads the demo dataset on a fresh instance; wiped automatically when the
          first real vendor connects.
        </Ep>
        <Ep sig="GET /api/audit?limit&before | ?format=csv" admin>
          The audit log - every sweep, every settings change, newest first;{" "}
          <Code>format=csv</Code> downloads the whole log. Viewing it is a licensed{" "}
          <Code>ee/</Code> feature.
        </Ep>
      </Section>

      <p className="text-sm text-muted-foreground">
        <Link href="/help" className="text-foreground underline underline-offset-4">
          Back to How it works
        </Link>
      </p>
    </div>
  );
}
