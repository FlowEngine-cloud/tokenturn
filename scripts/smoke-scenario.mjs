#!/usr/bin/env node
/**
 * End-to-end smoke scenario against a RUNNING instance (BASE_URL env, default
 * http://localhost:3000). Drives the real production paths:
 *
 *   healthz -> claim the instance as admin -> seed demo data -> walk every
 *   dashboard page + its APIs -> import a people CSV -> store secrets (Slack
 *   webhook, email provider) -> attempt a vendor connect with a canary token.
 *
 * Exits non-zero on the first failed step. Prints the canary secrets it
 * planted on stdout as JSON (last line) so the caller can grep the server
 * logs for leaks - the point of spec 12's CI log check.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

// Canary secrets shaped like real ones; none may ever appear in a log line.
const CANARIES = {
  adminPassword: "smoke-Admin-Passw0rd-canary",
  openaiKey: "sk-admin-smokecanary12345678901234567890",
  anthropicKey: "sk-ant-admin01-smokecanary-1234567890",
  githubPat: "ghp_smokecanary1234567890123456789012345",
  cursorKey: "key_smokecanarycursor1234567890",
  slackWebhook: "https://hooks.slack.com/services/T00000000/B00000000/smokecanaryslack0000000",
  emailApiKey: "re_smokecanaryemail_123456789012345678",
};

let cookie = "";

async function call(method, path, body, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !opts.raw ? { "content-type": "application/json" } : {}),
      ...(opts.contentType ? { "content-type": opts.contentType } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : opts.raw ? body : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie?.includes("ai_pnl_session=")) {
    cookie = setCookie.split(";")[0];
  }
  return res;
}

async function step(name, fn) {
  try {
    await fn();
    process.stderr.write(`ok   ${name}\n`);
  } catch (err) {
    process.stderr.write(`FAIL ${name}: ${err.message}\n`);
    process.exit(1);
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

const PEOPLE_CSV = `email,name
smoke.dana@example.com,Dana Smoke
smoke.noa@example.com,Noa Smoke
`;

async function main() {
  await step("healthz answers ok", async () => {
    // The container needs a moment after compose reports healthy-db.
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${BASE}/healthz`);
        if (res.status === 200) {
          const body = await res.json();
          expect(body.status === "ok" && body.db === "ok", `unexpected body ${JSON.stringify(body)}`);
          return;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("instance never became healthy");
  });

  await step("first visitor claims the instance as admin", async () => {
    const res = await call("POST", "/api/auth/setup/password", {
      name: "Smoke Admin",
      password: CANARIES.adminPassword,
    });
    expect(res.status === 200, `claim answered ${res.status}`);
    expect(cookie !== "", "claim set no session cookie");
  });

  await step("a second claim is refused", async () => {
    const saved = cookie;
    cookie = "";
    const res = await call("POST", "/api/auth/setup/password", {
      name: "Mallory",
      password: "second-claim-attempt",
    });
    cookie = saved;
    expect(res.status === 409, `second claim answered ${res.status}`);
  });

  await step("demo data seeds through the real tables", async () => {
    const res = await call("POST", "/api/demo");
    expect(res.status === 200, `demo answered ${res.status}`);
  });

  await step("onboarding completes", async () => {
    const res = await call("PATCH", "/api/onboarding", { stage: "done" });
    expect(res.status === 200, `onboarding answered ${res.status}`);
  });

  await step("every dashboard page renders", async () => {
    // /products and /tools are the old pages - they must redirect to /roi.
    for (const page of ["/", "/people", "/roi", "/products", "/tools", "/resolve", "/report", "/settings", "/help"]) {
      const res = await call("GET", page);
      expect(res.status === 200, `${page} answered ${res.status}`);
      const html = await res.text();
      expect(html.includes("Tokenturn"), `${page} looks wrong (no app shell)`);
    }
  });

  await step("the page APIs answer with demo numbers that drill", async () => {
    const overview = await (await call("GET", "/api/overview")).json();
    expect(overview.totals.totalCents > 0, "demo overview shows no spend");
    const people = await (await call("GET", "/api/people")).json();
    expect(people.people.length > 0, "demo has no people");
    const person = people.people.find((p) => p.id);
    const detail = await call("GET", `/api/people/${person.id}`);
    expect(detail.status === 200, `person drill answered ${detail.status}`);
    const facts = await (await call("GET", "/api/facts?person=" + person.id)).json();
    expect(Array.isArray(facts.facts), "person facts drill is not a list");
    for (const api of ["/api/roi", "/api/products/view", "/api/tools", "/api/tags", "/api/resolve", "/api/report", "/api/limits", "/api/version"]) {
      const res = await call("GET", api);
      expect(res.status === 200, `${api} answered ${res.status}`);
    }
  });

  await step("people CSV import previews and commits", async () => {
    const preview = await call("POST", "/api/people/import?preview=1", PEOPLE_CSV, {
      raw: true,
      contentType: "text/csv",
    });
    expect(preview.status === 200, `preview answered ${preview.status}`);
    const commit = await call("POST", "/api/people/import", PEOPLE_CSV, {
      raw: true,
      contentType: "text/csv",
    });
    expect(commit.status === 200, `commit answered ${commit.status}`);
    const body = await commit.json();
    expect(body.created === 2, `expected 2 created, got ${JSON.stringify(body)}`);
  });

  await step("secrets store encrypted and are never echoed back", async () => {
    const res = await call("PATCH", "/api/settings", {
      slack_webhook_url: CANARIES.slackWebhook,
      email_provider_config: {
        provider: "resend",
        from: "smoke@example.com",
        apiKey: CANARIES.emailApiKey,
      },
    });
    expect(res.status === 200, `settings answered ${res.status}`);
    const text = JSON.stringify(await res.json());
    expect(!text.includes(CANARIES.slackWebhook), "settings echoed the webhook back");
    expect(!text.includes(CANARIES.emailApiKey), "settings echoed the email key back");
  });

  await step("vendor connects reject bad canary tokens without leaking them", async () => {
    const attempts = [
      ["openai", { adminKey: CANARIES.openaiKey }],
      ["anthropic", { adminKey: CANARIES.anthropicKey }],
      ["github", { org: "smoke-org", token: CANARIES.githubPat }],
      ["cursor", { apiKey: CANARIES.cursorKey }],
    ];
    for (const [vendor, config] of attempts) {
      const res = await call("POST", `/api/connectors/${vendor}/connect`, config);
      // The vendor rejects the canary (or the network is closed) - either
      // way the connect must fail and the token must never be stored or
      // logged in plaintext.
      expect(res.status !== 200, `${vendor} accepted a canary token`);
      const body = JSON.stringify(await res.json().catch(() => ({})));
      expect(!body.includes(config.adminKey ?? config.token ?? config.apiKey ?? ""), `${vendor} echoed the token`);
    }
  });

  await step("report exports stream", async () => {
    const month = new Date().toISOString().slice(0, 7);
    for (const path of [`/api/report/csv?month=${month}`, `/api/report/focus?month=${month}`]) {
      const res = await call("GET", path);
      expect(res.status === 200, `${path} answered ${res.status}`);
    }
  });

  // Machine-readable canary list for the log-leak check - LAST line.
  process.stdout.write(JSON.stringify({ canaries: Object.values(CANARIES) }) + "\n");
}

main().catch((err) => {
  process.stderr.write(`FAIL ${err.stack ?? err}\n`);
  process.exit(1);
});
