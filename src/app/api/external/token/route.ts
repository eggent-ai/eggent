import {
  generateExternalApiToken,
  getExternalApiTokenStatus,
  maskExternalApiToken,
  saveExternalApiToken,
} from "@/lib/storage/external-api-token-store";

function resolveEnvToken(): string | null {
  const envToken = process.env.EXTERNAL_API_TOKEN?.trim();
  return envToken || null;
}

export async function GET() {
  const storedStatus = await getExternalApiTokenStatus();
  if (storedStatus.configured) {
    return Response.json({
      configured: true,
      source: "stored" as const,
      maskedToken: storedStatus.maskedToken,
      updatedAt: storedStatus.updatedAt,
    });
  }

  const envToken = resolveEnvToken();
  if (envToken) {
    return Response.json({
      configured: true,
      source: "env" as const,
      maskedToken: maskExternalApiToken(envToken),
      updatedAt: null as string | null,
    });
  }

  return Response.json({
    configured: false,
    source: "none" as const,
    maskedToken: null,
    updatedAt: null as string | null,
  });
}

export async function POST() {
  try {
    const token = generateExternalApiToken();
    await saveExternalApiToken(token);

    return Response.json({
      success: true,
      token,
      maskedToken: maskExternalApiToken(token),
      source: "stored" as const,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate token",
      },
      { status: 500 }
    );
  }
}
