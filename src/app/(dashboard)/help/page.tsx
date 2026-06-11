import type { Metadata } from "next";
import Link from "next/link";
import { Block, Code, Section } from "./section";

export const metadata: Metadata = { title: "Help - AI P&L" };

/** One page, two readers (spec 10): how the numbers work for the CFO,
 * the SDK and the ingest API for developers. Uniform type, no decoration.
 * The full endpoint list lives on /help/api. */

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <h1 className="text-lg font-semibold">How it works</h1>

      <Section title="Where the numbers come from">
        <p>
          Connectors pull spend from the vendors that bill you - Anthropic, OpenAI,
          Cursor, GitHub Copilot. No proxy, nothing in your request path. Every number
          on every page drills down to the vendor rows behind it.
        </p>
        <p>
          Token costs are <span className="text-foreground">estimated</span> from price
          tables until an invoice import trues them up to{" "}
          <span className="text-foreground">invoiced</span>. The split is always shown.
        </p>
      </Section>

      <Section title="People">
        <p>
          Identities match by email across vendors. Whatever can&apos;t be matched waits
          in Resolve - one click to fix, remembered forever. Spend nobody owns stays
          visible under Unassigned, never hidden.
        </p>
      </Section>

      <Section title="Keys and tags">
        <p>
          A key&apos;s name becomes its tag - the name says what the key is for.{" "}
          <Code>support-bot</Code> routes its spend to the Support Bot ROI;{" "}
          <Code>batch-*</Code> stays out of personal numbers; an agent&apos;s key tagged{" "}
          <Code>agent</Code> bills its ROI, not a person.
        </p>
      </Section>

      <Section title="ROI">
        <p>
          An ROI is a named calculation: a slice of spend &divide; a definition of
          success. The slice comes from a whole vendor, tagged keys, the SDK, or manual
          entry. Successes come from merged PRs (reverts within the window flip them
          back), <Code>track()</Code> events, or manual entry - each one points at a
          real record. Coding tools are built-in rows.
        </p>
        <p>$ per success = spend &divide; successes over the date range you pick. No success defined, no fake ROI - just cost.</p>
        <p>
          Value per success is optional. Set it per event (a $40 coupon, a $4.50
          ticket), or give the ROI a default value in Settings - applied at read
          time to successes without one, so changing it re-values history. Either way,
          ROI = value &divide; spend; with no value at all you get honest unit cost,
          never a fake ROI.
        </p>
      </Section>

      <Section title="Money and invoices">
        <p>
          Money is stored as billed - amount + currency - and converted to your display
          currency at read time using daily ECB rates; drill-downs always show the
          original amounts. Monthly invoice imports materialize the drift between
          estimate and bill as one visible adjustment line - per-person numbers stay
          exactly what the vendor reported, totals sum to what was actually billed.
        </p>
      </Section>

      <Section title="Limits and alerts">
        <p>
          Per-person monthly limits. Enforcement is only claimed where the vendor
          actually supports it; everywhere else you get Slack alerts at 80% and 100%,
          plus a burn alarm when someone&apos;s daily spend jumps far above their own
          average.
        </p>
      </Section>

      <h1 className="pt-2 text-lg font-semibold">For developers</h1>

      <Section title="Count an ROI from your code">
        <Block>
          {`import { pnl } from "@ai-pnl/sdk";

const ai = pnl.wrap(openai, { product: "support-bot" }); // counts every call

pnl.track("ticket_resolved", { value: 4.5, ref: ticket.id }); // records a success`}
        </Block>
        <p>
          <Code>wrap()</Code> counts spend on OpenAI and Anthropic clients, streaming
          included. <Code>track()</Code> records a success and its value; tokens spent
          in the same request attach to it automatically. <Code>ref</Code> ties the
          success to a real record (ticket id, coupon id) so it drills like everything
          else.
        </p>
        <p>
          Mint an ingest key in Settings - shown once, scoped to one ROI. The SDK
          fails open: buffering, retries and dedupe are built in, and an error never
          breaks your app. Python has the same API. Quickstarts live in the repo under{" "}
          <Code>sdk/</Code> and <Code>sdk-py/</Code>.
        </p>
      </Section>

      <Section title="Track without code">
        <p>
          The SDK is one HTTP call underneath - anything that can POST can report a
          success: an agent step, an n8n node, a Stripe webhook handler.
        </p>
        <Block>
          {`curl -X POST https://your-instance/api/ingest \\
  -H "Authorization: Bearer pnl_..." \\
  -H "Content-Type: application/json" \\
  -d '{"events":[{"id":"<uuid>","kind":"outcome","ts":"2026-06-11T12:00:00Z",
       "outcome":"coupon_created","ref":"SUMMER20"}]}'`}
        </Block>
        <p>
          Spend needs no call at all when a vendor key is routed to the ROI by tag -
          the connector already counts it. And tools with no API take manual monthly
          entries in Settings.
        </p>
      </Section>

      <Section title="API">
        <p>
          Every page is built on the same JSON API, so anything you see you can fetch.{" "}
          <Link href="/help/api" className="text-foreground underline underline-offset-4">
            Full API reference
          </Link>
          .
        </p>
      </Section>
    </div>
  );
}
