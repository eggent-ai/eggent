import fs from "fs/promises";
import path from "path";
import type { ChatFile } from "@/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");
const CHAT_FILES_DIR = path.join(DATA_DIR, "chat-files");

/**
 * Get the directory path for a chat's uploaded files
 */
export function getChatFilesDir(chatId: string): string {
    return path.join(CHAT_FILES_DIR, chatId);
}

/**
 * Ensure the chat files directory exists
 */
async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
}

/**
 * Get all files uploaded to a specific chat
 */
export async function getChatFiles(chatId: string): Promise<ChatFile[]> {
    const dir = getChatFilesDir(chatId);

    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files: ChatFile[] = [];

        for (const entry of entries) {
            if (entry.isFile()) {
                const fullPath = path.join(dir, entry.name);
                const stat = await fs.stat(fullPath);
                const ext = path.extname(entry.name).toLowerCase();

                files.push({
                    name: entry.name,
                    path: fullPath,
                    size: stat.size,
                    type: getFileType(ext),
                    uploadedAt: stat.mtime.toISOString(),
                });
            }
        }

        return files;
    } catch (error) {
        // Directory doesn't exist yet - no files uploaded
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

/**
 * Save a file to a chat's files directory
 */
export async function saveChatFile(
    chatId: string,
    fileBuffer: Buffer,
    filename: string
): Promise<ChatFile> {
    const dir = getChatFilesDir(chatId);
    await ensureDir(dir);

    // Sanitize filename to prevent path traversal
    const safeName = path.basename(filename);
    const fullPath = path.join(dir, safeName);

    await fs.writeFile(fullPath, fileBuffer);
    const stat = await fs.stat(fullPath);
    const ext = path.extname(safeName).toLowerCase();

    return {
        name: safeName,
        path: fullPath,
        size: stat.size,
        type: getFileType(ext),
        uploadedAt: new Date().toISOString(),
    };
}

/**
 * Delete a file from a chat's files directory
 */
export async function deleteChatFile(
    chatId: string,
    filename: string
): Promise<boolean> {
    const dir = getChatFilesDir(chatId);
    const safeName = path.basename(filename);
    const fullPath = path.join(dir, safeName);

    // Security: ensure path is within chat files directory
    const resolvedPath = path.resolve(fullPath);
    const resolvedDir = path.resolve(dir);
    if (!resolvedPath.startsWith(resolvedDir)) {
        return false;
    }

    try {
        await fs.unlink(fullPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Delete all files for a chat (when chat is deleted)
 */
export async function deleteAllChatFiles(chatId: string): Promise<void> {
    const dir = getChatFilesDir(chatId);
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch {
        // Ignore errors - directory may not exist
    }
}

/**
 * Get MIME type or simple type from file extension
 */
function getFileType(ext: string): string {
    const mimeTypes: Record<string, string> = {
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".json": "application/json",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".csv": "text/csv",
        ".xml": "application/xml",
        ".html": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
        ".ts": "application/typescript",
        ".py": "text/x-python",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };

    return mimeTypes[ext] || "application/octet-stream";
}
