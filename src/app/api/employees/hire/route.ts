import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { getServerLocale } from "@/i18n/server";
import { hireEmployee } from "@/lib/employees/onboarding";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Hires an employee from inside the app: a form with `skill`, the answer to
 * its question as `input`, and for an employee that asks for a file, `file`.
 */
export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true, body: "multipart" });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const locale = await getServerLocale(req.headers.get("accept-language"));
  const form = await req.formData().catch(() => null);
  if (!form) return jsonError("Expected a form.", 400);
  const skill = String(form.get("skill") || "").trim();
  const input = String(form.get("input") || "").trim();
  const file = form.get("file");
  if (!skill) return jsonError("skill is required", 400);

  let tempDir: string | null = null;
  let filePath: string | undefined;
  try {
    if (file && typeof file === "object" && "arrayBuffer" in file && file.size > 0) {
      if (file.size > MAX_FILE_BYTES) return jsonError("The file is larger than 20 MB.", 413);
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "eggent-hire-"));
      const name = path.basename(String(file.name || "file")).replace(/[\\/\0]/g, "_").slice(-120) || "file";
      filePath = path.join(tempDir, name);
      await fs.writeFile(filePath, Buffer.from(await file.arrayBuffer()));
    }
    if (!input && !filePath) return jsonError("Give the employee what it asks for.", 400);
    const hired = await hireEmployee({ skill, input, filePath, locale });
    if (!hired.ok) return jsonError(hired.error, hired.code);
    return Response.json({ projectId: hired.result.projectId, chatId: hired.result.chatId, message: hired.result.message, role: hired.result.skill.employee?.role }, { status: 201 });
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
