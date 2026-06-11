import type { Metadata } from "next";
import { APP_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";
import { Block, Code } from "../section";

export const metadata: Metadata = { title: `API reference - ${APP_NAME}` };

/** The full endpoint list (spec 10 help, grown in place): every number in the
 * dashboard comes from these routes - the UI has no private data path. Facts
 * here mirror the route docstrings; when they disagree, the route wins. */

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const METHOD_STYLES: Record<Method, string> = {
  GET: "bg-emerald-500/15 text-emerald-700",
  POST: "bg-sky-500/15 text-sky-700",
  PUT: "bg-amber-500/15 text-amber-700",
  PATCH: "bg-amber-500/15 text-amber-700",
  DELETE: "bg-rose-500/15 text-rose-700",
};

const AUTH_LABELS = {
  session: null,
  admin: "admin",
  ingest: "ingest key",
  public: "public",
} as const;

function Endpoint({
  methods,
  path,
  query,
  auth = "session",
  children,
}: {
  methods: Method[];
  path: string;
  query?: string;
  auth?: keyof typeof AUTH_LABELS;
  children: React.ReactNode;
}) {
  const label = AUTH_LABELS[auth];
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        {methods.map((m) => (
          <span
            key={m}
            className={cn(
              "rounded-full px-2 py-0.5 font-mono text-xs font-semibold",
              METHOD_STYLES[m],
            )}
          >
            {m}
          </span>
        ))}
        <code className="min-w-0 break-all font-mono text-sm text-foreground">
          {path}
          {query && <span className="text-muted-foreground">{query}</span>}
        </code>
        {label && (
          <span className="ml-auto rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {label}
          </span>
        )}
      </div>
      <div className="space-y-2 border-t px-4 py-3 text-sm text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

const SECTIONS = [
  { id: "auth", title: "Auth" },
  { id: "ingest", title: "Ingest" },
  { id: "ledger", title: "Read the ledger" },
  { id: "people", title: "People" },
  { id: "roi", title: "ROI" },
  { id: "tags", title: "Tags" },
  { id: "resolve", title: "Resolve" },
  { id: "connectors", title: "Connectors" },
  { id: "report", title: "Report and money" },
  { id: "admin", title: "Admin" },
];

function ApiSection({
  id,
  intro,
  children,
}: {
  id: string;
  intro?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const title = SECTIONS.find((s) => s.id === id)?.title;
  return (
    <section id={id} className="scroll-mt-20 space-y-3">
      <h2 className="font-medium">{title}</h2>
      {intro && <div className="space-y-2 text-sm text-muted-foreground">{intro}</div>}
      {children}
    </section>
  );
}

export default function ApiReferencePage() {
  return (
    <div className="flex max-w-5xl gap-10">
      <nav className="hidden w-40 shrink-0 lg:block print:hidden">
        <div className="sticky top-20 space-y-1 text-sm">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="block text-muted-foreground hover:text-foreground"
            >
              {s.title}
            </a>
          ))}
        </div>
      </nav>

      <div className="min-w-0 flex-1 space-y-10">
        <h1 className="text-lg font-semibold">API reference</h1>

        <ApiSection
          id="auth"
          intro={
            <p>
              The dashboard&apos;s own endpoints use the login session cookie: every
              logged-in user can read, only the admin can write (marked{" "}
              <span className="text-foreground">admin</span>). The one endpoint meant
              for your systems is <Code>POST /api/ingest</Code>, authenticated by a
              Bearer <span className="text-foreground">ingest key</span> minted in
              Settings. Dates are <Code>YYYY-MM-DD</Code>; money travels as integer
              cents.
            </p>
          }
        />

        <ApiSection id="ingest">
          <Endpoint methods={["POST"]} path="/api/ingest" auth="ingest">
            <p>
              Body <Code>{`{"events": [...]}`}</Code> - up to 500 events, 1 MB, 600
              requests per key per minute. Each event answers with its own verdict -{" "}
              <Code>accepted</Code> / <Code>duplicate</Code> / <Code>rejected</Code>{" "}
              plus the reason verbatim - so one bad event never sinks a batch. Events
              carry your UUID and the server upserts on it: retries never double-count.
            </p>
            <p>
              A <span className="text-foreground">call event</span> (spend; the ROI
              needs attribution <Code>sdk</Code>) prices tokens from the same pinned
              table as the connectors:
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
              email, the Resolve queue when unknown, full-history re-attribution on a
              later match.
            </p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/ingest-keys">
            <p>Lists keys - prefixes only, never tokens.</p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/ingest-keys" auth="admin">
            <p>
              Mints a key scoped to one ROI. The token is in this response and nowhere
              else - shown exactly once.
            </p>
          </Endpoint>
          <Endpoint methods={["PATCH"]} path="/api/ingest-keys/{id}" auth="admin">
            <p>
              <Code>{`{"revoked": true}`}</Code> - the permanent kill switch.
            </p>
          </Endpoint>
        </ApiSection>

        <ApiSection id="ledger">
          <Endpoint methods={["GET"]} path="/api/overview" query="?from&to">
            <p>
              Total spend with the estimated/invoiced split, attribution coverage with
              the Unassigned remainder, daily trend, spend by vendor, top people and
              ROI, connector health.
            </p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/roi" query="?from&to">
            <p>
              Every ROI calculation over the range in one list - spend, tokens,
              successes, $ and tokens per success, value, and the multiple.
            </p>
          </Endpoint>
          <Endpoint
            methods={["GET"]}
            path="/api/facts"
            query="?from&to&day&vendor&person&product&key&model&basis"
          >
            <p>
              Raw spend facts. Totals cover the whole filter, so a drill provably sums
              to its tile; every row carries the vendor <Code>source_ref</Code>.
            </p>
          </Endpoint>
          <Endpoint
            methods={["GET"]}
            path="/api/outcomes"
            query="?from&to&person&product&kind&tool"
          >
            <p>
              Raw outcomes, count-aware, with the live/reverted split and AI authorship
              tags.
            </p>
          </Endpoint>
          <Endpoint
            methods={["GET"]}
            path="/api/metrics"
            query="?from&to&vendor&metric&person&key"
          >
            <p>
              Raw usage counters; <Code>metric</Code> takes a comma list, so an accept
              rate&apos;s two inputs land on one page.
            </p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/runs" query="?vendor">
            <p>Sync history per connector.</p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/search" query="?q=">
            <p>Cmd-K: people, ROI, vendors, pages.</p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/limits">
            <p>
              Our limit next to the vendor&apos;s own, with what each vendor can
              actually enforce stated verbatim.
            </p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/version">
            <p>
              Running version; checks GitHub releases only when the off-by-default
              setting is on.
            </p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/healthz" auth="public">
            <p>
              <Code>200</Code> when app and database are up, <Code>503</Code>{" "}
              otherwise.
            </p>
          </Endpoint>
        </ApiSection>

        <ApiSection id="people">
          <Endpoint methods={["GET"]} path="/api/people" query="?from&to">
            <p>
              Everyone plus the Unassigned bucket - spend by vendor, live outcomes,
              $/outcome, daily trend.
            </p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/people/{id}" query="?from&to">
            <p>
              One person - daily breakdown per vendor, keys and seats with tags and
              all-time last use, ROI touched, outcomes by kind. Follows merges to the
              surviving person.
            </p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/keys/{id}">
            <p>
              A key&apos;s all-time profile: tags with routing, owner, ROI, per-model
              spend, last used.
            </p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/people" auth="admin">
            <p>
              Add one person - same upsert and auto-match sweep as the CSV; the CSV is
              this in bulk.
            </p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/people/import" query="?preview=1" auth="admin">
            <p>
              CSV body, headers auto-detect (email required). <Code>preview=1</Code>{" "}
              returns per-row verdicts without committing; a commit is all-or-nothing.
              Re-import upserts by email, never removes anyone.
            </p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/people/invite" auth="admin">
            <p>
              <Code>{`{"personIds": [...], "vendors": [...]}`}</Code> - invite fan-out:
              every (person, vendor) pair gets its own result, one vendor failing never
              blocks the rest.
            </p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/people/{id}/keys" auth="admin">
            <p>
              <Code>{`{"vendor": "openai", "projectId"?}`}</Code> - mints an OpenAI key
              for the person. The key value is in this response exactly once - never
              stored, never logged. Anthropic has no key-creation API; keys people mint
              themselves auto-map on the next sync.
            </p>
          </Endpoint>
          <Endpoint methods={["PUT"]} path="/api/people/{id}/limit" auth="admin">
            <p>
              <Code>{`{"limitUsdCents": 50000}`}</Code> - monthly alert limit;{" "}
              <Code>null</Code> clears. An alert, never a hard stop.
            </p>
          </Endpoint>
          <Endpoint methods={["GET", "POST"]} path="/api/people/{id}/offboard" auth="admin">
            <p>
              <Code>GET</Code> is the plan - every key and seat across every vendor;{" "}
              <Code>POST</Code> is the sweep. Failed items keep the vendor&apos;s error
              verbatim and retry one by one via{" "}
              <Code>{`POST .../offboard/retry {"itemId"}`}</Code>. History survives.
            </p>
          </Endpoint>
          <Endpoint methods={["DELETE"]} path="/api/people/{id}" auth="admin">
            <p>
              Removes the person and scrubs their personal data; their spend stays on
              the ledger as Unassigned, so no total ever changes. Irreversible.
            </p>
          </Endpoint>
        </ApiSection>

        <ApiSection
          id="roi"
          intro={
            <p>
              ROI rows kept their original <Code>/api/products</Code> paths (spec
              10.3).
            </p>
          }
        >
          <Endpoint methods={["GET"]} path="/api/products">
            <p>Every ROI row with rollup-backed totals.</p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/products/view" query="?from&to">
            <p>
              Each ROI row&apos;s own metric in its own unit, plus the multiple where
              real value exists.
            </p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/products/{id}" query="?from&to">
            <p>
              Spend by basis, vendor, person, and day; outcomes by kind; unit cost,
              value, ROI; the keys routed to it; manual entries.
            </p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/products" auth="admin">
            <p>
              Create an ROI row: name, attribution (<Code>connector</Code>,{" "}
              <Code>key</Code>, <Code>sdk</Code>, <Code>manual</Code>), success metric
              (<Code>none</Code>, <Code>github_pr</Code>, <Code>issue_done</Code>,{" "}
              <Code>sdk_event</Code>, <Code>manual</Code>), optional default value per
              success.
            </p>
          </Endpoint>
          <Endpoint methods={["PATCH"]} path="/api/products/{id}" auth="admin">
            <p>
              Change it. Archive (<Code>{`"archived": true`}</Code>) is the only exit -
              history stays fully readable. <Code>defaultValueCents</Code> re-values
              unvalued outcomes at read time.
            </p>
          </Endpoint>
          <Endpoint methods={["PUT"]} path="/api/products/{id}/manual" auth="admin">
            <p>
              Monthly cost or outcome entries for tools with no API - one entry per
              ROI, kind, and month; a PUT for the same month rewrites it in place.
            </p>
          </Endpoint>
        </ApiSection>

        <ApiSection id="tags">
          <Endpoint methods={["GET"]} path="/api/tags">
            <p>Every tag in use with the keys and spend behind it.</p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/tags/{tag}">
            <p>
              The ledger filtered by tag, across all employees and keys, down to vendor
              rows.
            </p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/tags" auth="admin">
            <p>
              <Code>{`{"tag": "devin"}`}</Code> - add a tag ahead of its keys: name a
              key with it in the vendor console and its spend lands under it on next
              sync. Idempotent.
            </p>
          </Endpoint>
          <Endpoint methods={["PATCH"]} path="/api/tags/{tag}" auth="admin">
            <p>
              <Code>{`{"countsPersonal"?, "productId"?}`}</Code> -{" "}
              <Code>countsPersonal: false</Code> flags spend out of personal numbers;{" "}
              <Code>productId</Code> routes every key carrying the tag to an ROI,
              re-attributing full history.
            </p>
          </Endpoint>
        </ApiSection>

        <ApiSection id="resolve">
          <Endpoint methods={["GET"]} path="/api/resolve">
            <p>The identity queue with explainable suggestions, plus tag conflicts.</p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/resolve/{id}/confirm" auth="admin">
            <p>
              Matches an identity to a person, re-attributes its full history, and is
              remembered forever.
            </p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/resolve/{id}/not-person" auth="admin">
            <p>
              A service account: routes to an ROI and/or tag; auto-match never re-fills
              it.
            </p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/resolve/merge" auth="admin">
            <p>
              Two emails, one human - identities, history, and email follow the
              survivor.
            </p>
          </Endpoint>
        </ApiSection>

        <ApiSection id="connectors">
          <Endpoint methods={["GET"]} path="/api/connectors">
            <p>Health: last sync, row counts, the vendor&apos;s error verbatim.</p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/connectors/{vendor}/connect" auth="admin">
            <p>
              Validates token scopes on connect; credentials stored encrypted, never
              read back.
            </p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/connectors/{vendor}/sync" auth="admin">
            <p>Sync now.</p>
          </Endpoint>
          <Endpoint methods={["GET", "DELETE"]} path="/api/connectors/{vendor}" auth="admin">
            <p>
              Connector detail; <Code>DELETE</Code> disconnects (synced history stays).
            </p>
          </Endpoint>
          <Endpoint methods={["GET", "PUT"]} path="/api/connectors/{vendor}/projects" auth="admin">
            <p>
              Success integrations (Jira, Linear): the project → ROI mapping.{" "}
              <Code>GET</Code> lists the vendor&apos;s projects/teams with their
              mapping; <Code>PUT</Code> <Code>{`{"project", "productId"}`}</Code> maps
              one (null clears it) and re-routes its history retroactively.
            </p>
          </Endpoint>
        </ApiSection>

        <ApiSection id="report">
          <Endpoint methods={["GET"]} path="/api/report" query="?month=YYYY-MM">
            <p>
              The CFO month: spend by ROI and by person with month-over-month, unit
              costs, ROI where defined, six-month trend. Always sums to the whole
              ledger.
            </p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/report/csv" query="?month=">
            <p>The same table as CSV.</p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/report/focus" query="?month=">
            <p>A FOCUS 1.4 export - one row per raw spend fact, for any FinOps tool.</p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/invoices">
            <p>
              The drift report: estimated vs invoiced facts vs the invoice, per
              vendor-month.
            </p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/invoices/import" query="?preview=1" auth="admin">
            <p>
              CSV body (<Code>vendor, month, amount, currency</Code> + optional ref and
              note). Only completed months; re-import corrects in place.
            </p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/fx">
            <p>Daily ECB rate coverage and the last run.</p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/fx/sync" auth="admin">
            <p>Fetch rates now.</p>
          </Endpoint>
        </ApiSection>

        <ApiSection id="admin">
          <Endpoint methods={["GET"]} path="/api/settings">
            <p>
              Everything configurable - thresholds, display currency, Slack webhook,
              email provider. Secrets are stored encrypted and never echoed back.
            </p>
          </Endpoint>
          <Endpoint methods={["PATCH"]} path="/api/settings" auth="admin">
            <p>
              Change settings; <Code>null</Code> clears a secret.
            </p>
          </Endpoint>
          <Endpoint methods={["GET", "POST"]} path="/api/users" auth="admin">
            <p>
              View-only users (username + password). The one admin is whoever claimed
              the instance.
            </p>
          </Endpoint>
          <Endpoint methods={["DELETE"]} path="/api/users/{id}" auth="admin">
            <p>Remove a view-only user.</p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/email/test" auth="admin">
            <p>
              <Code>{`{"to": ...}`}</Code> - sends through the configured provider and
              returns its rejection verbatim.
            </p>
          </Endpoint>
          <Endpoint methods={["POST"]} path="/api/demo" auth="admin">
            <p>
              Loads the demo dataset on a fresh instance; wiped automatically when the
              first real vendor connects.
            </p>
          </Endpoint>
          <Endpoint methods={["GET"]} path="/api/audit" query="?limit&before | ?format=csv" auth="admin">
            <p>
              The audit log - every sweep, every settings change, newest first;{" "}
              <Code>format=csv</Code> downloads the whole log. Viewing it is a licensed{" "}
              <Code>ee/</Code> feature.
            </p>
          </Endpoint>
        </ApiSection>
      </div>
    </div>
  );
}
