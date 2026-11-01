/**
 * eggent_send_summary: an employee's first job ends with a letter to the
 * person - what it found, with the files it made - so the result is there
 * after the tab is closed. The deployment sends it (EGGENT_EMPLOYEE_SUMMARY_URL)
 * to the address the person signed up with; without one the tool is absent.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SUMMARY_TOOL = "eggent_send_summary";

const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export function summaryConfigured(): boolean {
  return Boolean(process.env.EGGENT_EMPLOYEE_SUMMARY_URL?.trim() && process.env.EGGENT_SERVICES_TOKEN?.trim());
}

export function createSummaryTool(options: { cwd?: string; fromName?: string }) {
  return defineTool({
    name: SUMMARY_TOOL,
    label: "Send Summary",
    promptSnippet: "email the person a summary of the first job, with its files",
    description:
      "Email the person who hired you a short summary of the work you just finished, with up to five files you made, to the address they signed up with. Use it once, at the end of your first job, when a skill says so. Write the letter in the person's language: what you did, what you found, what you made, what you suggest next. Then tell them it went, by the address the result names; when the result names the address it came from, that is your own mail address - say that they can write to you there.",
    parameters: Type.Object({
      subject: Type.String({ description: "The letter's subject: what this is about, in a few words." }),
      text: Type.String({ description: "The letter itself, plain text with short paragraphs and lists." }),
      files: Type.Optional(Type.Array(Type.String(), { description: "Paths of files in your working folder to attach." })),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const url = process.env.EGGENT_EMPLOYEE_SUMMARY_URL?.trim();
      const token = process.env.EGGENT_SERVICES_TOKEN?.trim();
      if (!url || !token) return textResult(JSON.stringify({ sent: false, reason: "not_configured" }));
      const root = path.resolve(options.cwd || ctx?.cwd || process.cwd());
      const files: Array<{ name: string; content: string }> = [];
      let total = 0;
      for (const asked of (params.files ?? []).slice(0, MAX_FILES)) {
        const absolute = path.resolve(root, asked);
        if (!absolute.startsWith(root + path.sep)) return textResult(JSON.stringify({ sent: false, error: `${asked} is outside your working folder.` }));
        const data = await fs.readFile(absolute).catch(() => null);
        if (!data) return textResult(JSON.stringify({ sent: false, error: `${asked} is not there.` }));
        total += data.length;
        if (total > MAX_TOTAL_BYTES) return textResult(JSON.stringify({ sent: false, error: "The files are larger than 10 MB together; attach fewer." }));
        files.push({ name: path.basename(absolute), content: data.toString("base64") });
      }
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ subject: params.subject, text: params.text, files, ...(options.fromName ? { fromName: options.fromName } : {}) }),
        signal: signal ?? AbortSignal.timeout(30_000),
      }).catch((error: unknown) => ({ ok: false, status: 0, json: async () => ({ reason: String(error) }) }) as const);
      const answer = (await response.json().catch(() => ({}))) as { sent?: boolean; to?: string; from?: string; reason?: string };
      if (answer.sent) return textResult(JSON.stringify({ sent: true, to: answer.to, ...(answer.from ? { from: answer.from } : {}) }), { sent: true });
      return textResult(JSON.stringify({ sent: false, reason: answer.reason || `status ${response.status}`, note: "Do not say it was sent. Offer the files here instead." }));
    },
  });
}
