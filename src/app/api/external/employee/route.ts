import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { getExternalApiToken } from "@/lib/storage/external-api-token-store";
import { getServerLocale } from "@/i18n/server";
import { hireEmployee } from "@/lib/employees/onboarding";

/**
 * Hires an employee for a relay that runs the first job itself - the shared
 * Telegram bot, which then sends the returned message to its project so the
 * job streams into the chat. The external API's token, as for messages.
 * Body: {skill, input?, file?: {name, content (base64)}}.
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;

function bearer(req: NextRequest): string | null {
  const [scheme, token] = (req.headers.get("authorization") || "").trim().split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function POST(req: NextRequest) {
  const stored = await getExternalApiToken();
  const fromEnv = process.env.EXTERNAL_API_TOKEN?.trim();
  const given = bearer(req);
  if (!given || ![stored, fromEnv].some((token) => token && same(given, token))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { skill?: unknown; input?: unknown; file?: { name?: unknown; content?: unknown } } | null;
  const skill = typeof body?.skill === "string" ? body.skill : "";
  if (!skill) return Response.json({ error: "skill is required" }, { status: 400 });
  const locale = await getServerLocale(req.headers.get("accept-language"));
  let tempDir: string | null = null;
  try {
    let filePath: string | undefined;
    if (body?.file && typeof body.file.content === "string") {
      const data = Buffer.from(body.file.content, "base64");
      if (data.length > MAX_FILE_BYTES) return Response.json({ error: "The file is larger than 20 MB." }, { status: 413 });
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "eggent-hire-"));
      const name = path.basename(String(body.file.name || "file")).replace(/[\\/\0]/g, "_").slice(-120) || "file";
      filePath = path.join(tempDir, name);
      await fs.writeFile(filePath, data);
    }
    const hired = await hireEmployee({ skill, input: typeof body?.input === "string" ? body.input : "", filePath, locale, startTurn: false });
    if (!hired.ok) return Response.json({ error: hired.error }, { status: hired.code });
    return Response.json({ projectId: hired.result.projectId, message: hired.result.message, role: hired.result.skill.employee?.role });
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
