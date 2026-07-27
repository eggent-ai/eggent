import { NextRequest } from "next/server";
import {
    getChatFiles,
    saveChatFile,
    deleteChatFile,
} from "@/lib/storage/chat-files-store";
import { getServerTranslator } from "@/i18n/server";

/**
 * GET /api/chat/files?chatId=xxx
 * List all files uploaded to a chat
 */
export async function GET(req: NextRequest) {
    const t = await getServerTranslator(req.headers.get("accept-language"));
    const chatId = req.nextUrl.searchParams.get("chatId");

    if (!chatId) {
        return Response.json(
            { error: t("api.error.chatIdRequired") },
            { status: 400 }
        );
    }

    try {
        const files = await getChatFiles(chatId);
        return Response.json({ files });
    } catch (error) {
        console.error("Error getting chat files:", error);
        return Response.json(
            { error: t("api.error.failedGetChatFiles") },
            { status: 500 }
        );
    }
}

/**
 * POST /api/chat/files
 * Upload a file to a chat (multipart/form-data)
 */
export async function POST(req: NextRequest) {
    const t = await getServerTranslator(req.headers.get("accept-language"));
    try {
        const formData = await req.formData();
        const chatId = formData.get("chatId") as string;
        const file = formData.get("file") as File | null;

        if (!chatId) {
            return Response.json(
                { error: t("api.error.chatIdRequired") },
                { status: 400 }
            );
        }

        if (!file) {
            return Response.json(
                { error: t("api.error.fileRequired") },
                { status: 400 }
            );
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const savedFile = await saveChatFile(chatId, buffer, file.name);

        return Response.json({ file: savedFile });
    } catch (error) {
        console.error("Error uploading chat file:", error);
        return Response.json(
            { error: t("api.error.failedUploadFile") },
            { status: 500 }
        );
    }
}

/**
 * DELETE /api/chat/files?chatId=xxx&filename=yyy
 * Delete a file from a chat
 */
export async function DELETE(req: NextRequest) {
    const t = await getServerTranslator(req.headers.get("accept-language"));
    const chatId = req.nextUrl.searchParams.get("chatId");
    const filename = req.nextUrl.searchParams.get("filename");

    if (!chatId || !filename) {
        return Response.json(
            { error: t("api.error.chatIdAndFilenameRequired") },
            { status: 400 }
        );
    }

    try {
        const deleted = await deleteChatFile(chatId, filename);
        if (!deleted) {
            return Response.json(
                { error: t("api.error.fileNotFound") },
                { status: 404 }
            );
        }
        return Response.json({ success: true });
    } catch (error) {
        console.error("Error deleting chat file:", error);
        return Response.json(
            { error: t("api.error.failedDeleteFile") },
            { status: 500 }
        );
    }
}
