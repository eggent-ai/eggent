import type { NextRequest } from "next/server";
import { getAllChats, getChat, deleteChat } from "@/lib/storage/chat-store";
import { matchesIfNoneMatch, weakEtag } from "@/lib/etag";

export async function GET(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get("id");

  if (chatId) {
    const chat = await getChat(chatId);
    if (!chat) {
      return Response.json({ error: "Chat not found" }, { status: 404 });
    }
    // The open chat is fetched again on every background sync - every thirty
    // seconds and whenever the window regains focus - and almost every time
    // nothing has changed. With a validator the browser asks whether it has,
    // and an unchanged conversation costs a 304 instead of all of it again.
    const body = JSON.stringify(chat);
    const etag = weakEtag(body);
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-cache",
      ETag: etag,
    };
    if (matchesIfNoneMatch(req.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, { headers });
  }

  const projectId = req.nextUrl.searchParams.get("projectId");
  let chats = await getAllChats();

  // Filter by project: "none" means global chats (no project),
  // a project ID filters to that project's chats
  if (projectId === "none") {
    chats = chats.filter((c) => !c.projectId);
  } else if (projectId) {
    chats = chats.filter((c) => c.projectId === projectId);
  }

  return Response.json(chats);
}

export async function DELETE(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get("id");
  if (!chatId) {
    return Response.json({ error: "Chat ID required" }, { status: 400 });
  }

  const deleted = await deleteChat(chatId);
  if (!deleted) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  return Response.json({ success: true });
}
