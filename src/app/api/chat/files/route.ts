import { NextRequest } from "next/server";
import {
    getChatFiles,
    saveChatFile,
    deleteChatFile,
} from "@/lib/storage/chat-files-store";

/**
 * GET /api/chat/files?chatId=xxx
 * List all files uploaded to a chat
 */
export async function GET(req: NextRequest) {
    const chatId = req.nextUrl.searchParams.get("chatId");

    if (!chatId) {
        return Response.json(
            { error: "chatId is required" },
            { status: 400 }
        );
    }

    try {
        const files = await getChatFiles(chatId);
        return Response.json({ files });
    } catch (error) {
        console.error("Error getting chat files:", error);
        return Response.json(
            { error: "Failed to get chat files" },
            { status: 500 }
        );
    }
}

/**
 * POST /api/chat/files
 * Upload a file to a chat (multipart/form-data)
 */
export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const chatId = formData.get("chatId") as string;
        const file = formData.get("file") as File | null;

        if (!chatId) {
            return Response.json(
                { error: "chatId is required" },
                { status: 400 }
            );
        }

        if (!file) {
            return Response.json(
                { error: "file is required" },
                { status: 400 }
            );
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const savedFile = await saveChatFile(chatId, buffer, file.name);

        return Response.json({ file: savedFile });
    } catch (error) {
        console.error("Error uploading chat file:", error);
        return Response.json(
            { error: "Failed to upload file" },
            { status: 500 }
        );
    }
}

/**
 * DELETE /api/chat/files?chatId=xxx&filename=yyy
 * Delete a file from a chat
 */
export async function DELETE(req: NextRequest) {
    const chatId = req.nextUrl.searchParams.get("chatId");
    const filename = req.nextUrl.searchParams.get("filename");

    if (!chatId || !filename) {
        return Response.json(
            { error: "chatId and filename are required" },
            { status: 400 }
        );
    }

    try {
        const deleted = await deleteChatFile(chatId, filename);
        if (!deleted) {
            return Response.json(
                { error: "File not found" },
                { status: 404 }
            );
        }
        return Response.json({ success: true });
    } catch (error) {
        console.error("Error deleting chat file:", error);
        return Response.json(
            { error: "Failed to delete file" },
            { status: 500 }
        );
    }
}
