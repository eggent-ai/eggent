import type { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { resolveWorkspaceFile } from "@/lib/files/telegram-send";

/**
 * Whether the files an answer's card lists are still there.
 *
 *   GET /api/files/stat?project=<id|none>&path=a&path=b  ->  { files: [{ path, exists, size }] }
 *
 * A card is stored with its message and a file is deleted whenever its owner
 * likes, so the card asks before it offers a button that would only fail.
 */

const MAX_PATHS = 40;

export async function GET(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const project = req.nextUrl.searchParams.get("project");
  if (!project) return Response.json({ error: t("api.error.projectIdRequired") }, { status: 400 });
  const paths = req.nextUrl.searchParams.getAll("path").slice(0, MAX_PATHS);
  const files = await Promise.all(
    paths.map(async (relative) => {
      const file = await resolveWorkspaceFile(project, relative);
      return { path: relative, exists: Boolean(file), size: file?.size ?? 0 };
    })
  );
  return Response.json({ files }, { headers: { "Cache-Control": "no-store" } });
}
