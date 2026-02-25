import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  ExternalMessageError,
  handleExternalMessage,
} from "@/lib/external/handle-external-message";
import { getExternalApiToken } from "@/lib/storage/external-api-token-store";

interface ExternalMessageBody {
  sessionId?: unknown;
  message?: unknown;
  projectId?: unknown;
  chatId?: unknown;
  currentPath?: unknown;
}

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
            "WWW-Authenticate": 'Bearer realm="external-message"',
          },
        }
      );
    }

    const body = (await req.json()) as ExternalMessageBody;
    const result = await handleExternalMessage({
      sessionId:
        typeof body.sessionId === "string" ? body.sessionId : "",
      message: typeof body.message === "string" ? body.message : "",
      projectId:
        typeof body.projectId === "string" ? body.projectId : undefined,
      chatId: typeof body.chatId === "string" ? body.chatId : undefined,
      currentPath:
        typeof body.currentPath === "string" ? body.currentPath : undefined,
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
