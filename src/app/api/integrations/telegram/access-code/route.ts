import { NextRequest } from "next/server";
import { createTelegramAccessCode } from "@/lib/storage/telegram-integration-store";
import { getServerTranslator } from "@/i18n/server";

export async function POST(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  try {
    const body = (await req.json().catch(() => ({}))) as {
      ttlMinutes?: unknown;
    };
    const code = await createTelegramAccessCode({
      ttlMinutes: body.ttlMinutes,
    });

    return Response.json({
      success: true,
      code: code.code,
      createdAt: code.createdAt,
      expiresAt: code.expiresAt,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : t("api.error.telegramAccessCodeFailed"),
      },
      { status: 500 }
    );
  }
}
