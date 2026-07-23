import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  ExternalMessageError,
  handleExternalMediaMessage,
} from "@/lib/external/handle-external-message";
import { getExternalApiToken } from "@/lib/storage/external-api-token-store";

function parseBearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;

  const [scheme, token] = header.trim().split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

function safeTokenMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }

  return timingSafeEqual(actualBytes, expectedBytes);
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function parseJsonObjectField(formData: FormData, key: string): Record<string, unknown> | undefined {
  const raw = formString(formData, key).trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeKind(value: string): "document" | "photo" | "audio" | "video" | "voice" | "file" {
  return ["document", "photo", "audio", "video", "voice", "file"].includes(value)
    ? value as "document" | "photo" | "audio" | "video" | "voice" | "file"
    : "file";
}

export async function POST(req: NextRequest) {
  try {
    const storedToken = await getExternalApiToken();
    const envToken = process.env.EXTERNAL_API_TOKEN?.trim();
    const expectedToken = storedToken || envToken;
    if (!expectedToken) {
      return Response.json(
        {
          error:
            "External API token is not configured. Set EXTERNAL_API_TOKEN or generate token in API page.",
        },
        { status: 503 }
      );
    }

    const providedToken = parseBearerToken(req);
    if (!providedToken || !safeTokenMatch(providedToken, expectedToken)) {
      return Response.json(
        { error: "Unauthorized" },
        {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer realm="external-media-message"',
          },
        }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "file is required" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await handleExternalMediaMessage({
      sessionId: formString(formData, "sessionId"),
      message: formString(formData, "message"),
      projectId: formString(formData, "projectId").trim() || undefined,
      projectName: formString(formData, "projectName").trim() || undefined,
      chatId: formString(formData, "chatId").trim() || undefined,
      currentPath: formString(formData, "currentPath"),
      runtimeData: parseJsonObjectField(formData, "runtimeData"),
      toolRuntimeData: parseJsonObjectField(formData, "toolRuntimeData"),
      publicMode: formString(formData, "publicMode") === "true",
      file: {
        buffer,
        filename: file.name || formString(formData, "filename") || "telegram-file",
        mimeType: file.type || formString(formData, "mimeType") || undefined,
        kind: normalizeKind(formString(formData, "kind")),
      },
    });

    return Response.json(result);
  } catch (error) {
    if (error instanceof ExternalMessageError) {
      return Response.json(error.payload, { status: error.status });
    }

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
