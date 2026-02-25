import { NextRequest } from "next/server";
import { getAllChats, getChat, deleteChat } from "@/lib/storage/chat-store";

export async function GET(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get("id");

  if (chatId) {
    const chat = await getChat(chatId);
    if (!chat) {
      return Response.json({ error: "Chat not found" }, { status: 404 });
    }
    return Response.json(chat);
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
