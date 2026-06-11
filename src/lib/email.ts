import { createHash, createHmac } from "node:crypto";
import { getPool, type Db } from "./db";
import { logger } from "./logger";
import { ResolveError } from "./resolve";
import { getSecretSetting, setSecretSetting, deleteSetting } from "./settings";

/**
 * Outbound email (spec 12b): a provider API key (Resend / Postmark / SES)
 * stored in Settings, encrypted like vendor tokens. No SMTP. Email is
 * optional - alerts default to the Slack webhook; only scheduled features
 * need a provider. The whole config (key included) lives in one secret
 * setting; reads only ever surface the provider name and from address.
 */

export const EMAIL_CONFIG_SETTING = "email_provider_config";

export const EMAIL_PROVIDERS = ["resend", "postmark", "ses"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export interface EmailConfig {
  provider: EmailProvider;
  /** The From address - must be a sender the provider has verified. */
  from: string;
  /** Resend API key / Postmark server token. */
  apiKey?: string;
  /** SES (SigV4) credentials. */
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && EMAIL_RE.test(value) && value.length <= 254;
}

/** Validate a Settings write; throws ResolveError(400) naming the problem. */
export function validateEmailConfig(raw: unknown): EmailConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ResolveError(
      "email_provider_config must be an object, or null to clear it",
      400,
    );
  }
  const record = raw as Record<string, unknown>;
  const provider = record.provider;
  if (!(EMAIL_PROVIDERS as readonly unknown[]).includes(provider)) {
    throw new ResolveError("provider must be resend, postmark, or ses", 400);
  }
  if (!isEmailAddress(record.from)) {
    throw new ResolveError("from must be an email address", 400);
  }
  const str = (key: string): string => {
    const value = record[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new ResolveError(`${key} is required for ${String(provider)}`, 400);
    }
    return value.trim();
  };
  const allowed =
    provider === "ses"
      ? ["provider", "from", "accessKeyId", "secretAccessKey", "region"]
      : ["provider", "from", "apiKey"];
  const extra = Object.keys(record).find((key) => !allowed.includes(key));
  if (extra !== undefined) {
    throw new ResolveError(`unknown email config field ${extra}`, 400);
  }
  if (provider === "ses") {
    const region = str("region");
    if (!REGION_RE.test(region)) {
      throw new ResolveError("region must be an AWS region like us-east-1", 400);
    }
    return {
      provider,
      from: record.from as string,
      accessKeyId: str("accessKeyId"),
      secretAccessKey: str("secretAccessKey"),
      region,
    };
  }
  return {
    provider: provider as EmailProvider,
    from: record.from as string,
    apiKey: str("apiKey"),
  };
}

export interface EmailOpts {
  db?: Db;
  /** Secrets-key directory override (tests). */
  dataDir?: string;
  fetch?: typeof fetch;
  /** Clock override (tests) - SigV4 signs the request time. */
  now?: Date;
}

export async function getEmailConfig(
  opts: EmailOpts = {},
): Promise<EmailConfig | null> {
  const db = opts.db ?? getPool();
  const raw = await getSecretSetting(EMAIL_CONFIG_SETTING, db, opts.dataDir);
  return raw === null ? null : (JSON.parse(raw) as EmailConfig);
}

export async function setEmailConfig(
  config: EmailConfig | null,
  opts: EmailOpts = {},
): Promise<void> {
  const db = opts.db ?? getPool();
  if (config === null) await deleteSetting(EMAIL_CONFIG_SETTING, db);
  else await setSecretSetting(EMAIL_CONFIG_SETTING, JSON.stringify(config), db, opts.dataDir);
}

/** What Settings shows: provider + from, never the credentials. */
export async function emailSummary(
  opts: EmailOpts = {},
): Promise<{ provider: EmailProvider; from: string } | null> {
  const config = await getEmailConfig(opts);
  return config === null ? null : { provider: config.provider, from: config.from };
}

// ---------------------------------------------------------------------------
// SES SigV4 (zero-dep; SES v2 SendEmail is the one AWS call we make)

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export interface SignedSesRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Sign an SES v2 SendEmail call (AWS Signature Version 4). Deterministic
 * given config + body + time, so tests pin the exact signature.
 */
export function signSesSendEmail(
  config: { accessKeyId: string; secretAccessKey: string; region: string },
  body: string,
  now: Date,
): SignedSesRequest {
  const host = `email.${config.region}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash = sha256Hex(body);

  const canonicalHeaders =
    `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = `POST\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`;

  const scope = `${dateStamp}/${config.region}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;

  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, "ses");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    url: `https://${host}${path}`,
    headers: {
      "content-type": "application/json",
      "x-amz-date": amzDate,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  };
}

// ---------------------------------------------------------------------------
// Send

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

async function providerError(res: Response, fallback: string): Promise<string> {
  // The provider's error, verbatim - each names its message field
  // differently (Resend: message, Postmark: Message, SES: message).
  const text = await res.text();
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (typeof body.message === "string") return body.message;
    if (typeof body.Message === "string") return body.Message;
  } catch {
    if (text.trim() !== "") return text.trim();
  }
  return fallback;
}

/**
 * Send one plain-text email through the configured provider. Throws with
 * the provider's error verbatim; no provider configured throws too -
 * callers that treat email as optional check emailSummary first.
 */
export async function sendEmail(
  message: EmailMessage,
  opts: EmailOpts = {},
): Promise<{ provider: EmailProvider }> {
  const config = await getEmailConfig(opts);
  if (config === null) {
    throw new ResolveError("no email provider configured - set one in Settings", 409);
  }
  const fetchImpl = opts.fetch ?? fetch;

  let res: Response;
  if (config.provider === "resend") {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });
  } else if (config.provider === "postmark") {
    res = await fetchImpl("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "x-postmark-server-token": config.apiKey ?? "",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        From: config.from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        MessageStream: "outbound",
      }),
    });
  } else {
    const signed = signSesSendEmail(
      {
        accessKeyId: config.accessKeyId ?? "",
        secretAccessKey: config.secretAccessKey ?? "",
        region: config.region ?? "",
      },
      JSON.stringify({
        FromEmailAddress: config.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject },
            Body: { Text: { Data: message.text } },
          },
        },
      }),
      opts.now ?? new Date(),
    );
    res = await fetchImpl(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    });
  }

  if (!res.ok) {
    throw new Error(
      await providerError(res, `${config.provider} returned HTTP ${res.status}`),
    );
  }
  logger.info("email sent", { provider: config.provider, to: message.to });
  return { provider: config.provider };
}
