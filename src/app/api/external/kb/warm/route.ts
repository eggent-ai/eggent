import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getExternalApiToken } from "@/lib/storage/external-api-token-store";
import { getProject, getWorkDir, isOrchestratorScope } from "@/lib/storage/project-store";
import { warmKbIndex } from "@/lib/kb/index";
import { getServerTranslator } from "@/i18n/server";

/**
 * Build a project's search index before anybody asks it anything.
 *
 * A project shared with people answers through kb_search, which brings the
 * index up to date on every question; the first one would otherwise wait for
 * every document to be read and embedded. Whoever shares the project calls
 * this once, with the same token as /api/external/message, and is told how
 * much the index holds: `{ files, chunks, embedded }` (passages with a vector).
 */

interface WarmBody {
  projectId?: unknown;
}

function parseBearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.trim().split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

function safeTokenMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

export async function POST(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const storedToken = await getExternalApiToken();
  const envToken = process.env.EXTERNAL_API_TOKEN?.trim();
  const expectedToken = storedToken || envToken;
  if (!expectedToken) {
    return Response.json({ error: t("api.error.externalTokenMissing") }, { status: 503 });
  }
  const providedToken = parseBearerToken(req);
  if (!providedToken ||
      // A token made in Settings must not lock out the deployment's own one,
      // which a hosting relay keeps sending.
      ![storedToken, envToken].some((token) => token && safeTokenMatch(providedToken, token))) {
    return Response.json(
      { error: t("api.error.unauthorized") },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="external-kb-warm"' } }
    );
  }

  const body = (await req.json().catch(() => null)) as WarmBody | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  // A project id is one folder name; the orchestrator's folder holds every project and is not one.
  if (!projectId || isOrchestratorScope(projectId) || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(projectId)) {
    return Response.json({ error: "projectId is required." }, { status: 400 });
  }
  if (!(await getProject(projectId))) {
    return Response.json({ error: t("api.error.projectNotFound") }, { status: 404 });
  }

  try {
    const { files, chunks, embedded } = await warmKbIndex(getWorkDir(projectId));
    return Response.json({ files, chunks, embedded });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : t("api.error.internal") },
      { status: 500 }
    );
  }
}
