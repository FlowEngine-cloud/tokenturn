import type { Metadata } from "next";
import Link from "next/link";
import { APP_NAME } from "@/lib/brand";
import { Block, Code, Section } from "../section";

export const metadata: Metadata = { title: `SDK - ${APP_NAME}` };

/** The developer view of help (spec 10): count an ROI from code, or from
 * anything that can POST. The endpoint list lives on /help/api. */

export default function SdkPage() {
  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-lg font-semibold">SDK</h1>

      <Section title="Count an ROI from your code">
        <Block>
          {`import { pnl } from "@tokenturn/sdk";

const ai = pnl.wrap(openai, { roi: "support-bot" }); // counts every call

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
          entries on the ROI&apos;s own page.
        </p>
      </Section>

      <Section title="API">
        <p>
          Every page is built on the same JSON API, so anything you see you can fetch -
          the full endpoint list is under the{" "}
          <Link href="/help/api" className="text-foreground underline underline-offset-4">
            API reference
          </Link>{" "}
          tab.
        </p>
      </Section>
    </div>
  );
}
