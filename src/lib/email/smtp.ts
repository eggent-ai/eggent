import nodemailer, { type Transporter } from "nodemailer";
import { getEmailConfig } from "@/lib/email/config";

/**
 * Sending through the workspace's own mail server (EGGENT_SMTP_URL), for a
 * self-hosted workspace with no email service. One transport per URL; tests
 * put their own in.
 */

type TransportFactory = (smtpUrl: string) => Transporter;

let factory: TransportFactory | null = null;
let cached: { url: string; transport: Transporter } | null = null;

export function setSmtpTransportForTests(next: TransportFactory | null): void {
  factory = next;
  cached?.transport.close();
  cached = null;
}

function transportFor(smtpUrl: string): Transporter {
  if (cached?.url === smtpUrl) return cached.transport;
  cached?.transport.close();
  const transport = factory ? factory(smtpUrl) : nodemailer.createTransport(smtpUrl);
  cached = { url: smtpUrl, transport };
  return transport;
}

/** One line, no header of its own: a value that becomes a header line. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export async function sendThroughSmtp(letter: {
  to: string[];
  subject: string;
  text: string;
  attachments: Array<{ name: string; mime?: string; data: Buffer }>;
}): Promise<{ messageId: string; accepted: string[] }> {
  const config = getEmailConfig();
  if (config?.mode !== "smtp") throw new Error("This workspace has no mail server set up.");
  const info = await transportFor(config.smtpUrl).sendMail({
    from: oneLine(config.from),
    to: letter.to,
    subject: oneLine(letter.subject),
    text: letter.text,
    headers: { "Auto-Submitted": "auto-generated" },
    attachments: letter.attachments.map((file) => ({ filename: oneLine(file.name), content: file.data, ...(file.mime ? { contentType: file.mime } : {}) })),
  });
  const accepted = Array.isArray(info.accepted)
    ? (info.accepted as unknown[]).map((entry) => String(entry && typeof entry === "object" && "address" in entry ? (entry as { address: unknown }).address : entry))
    : [];
  return { messageId: String(info.messageId || ""), accepted };
}

/** Where the server is, for the agent to say - never the login in the URL. */
export function smtpServerLabel(smtpUrl: string): string {
  try {
    const url = new URL(smtpUrl);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "the configured mail server";
  }
}
