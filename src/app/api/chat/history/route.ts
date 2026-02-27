import { NextRequest } from "next/server";
import { getAllChats, getChat, deleteChat } from "@/lib/storage/chat-store";
import { getCurrentUser } from "@/lib/auth/get-current-user";

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
  const user = await getCurrentUser();
  // Admins see all chats; regular users see only their own
  const filterUserId = user?.role === "admin" ? undefined : user?.id;
  let chats = await getAllChats(filterUserId);

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

  // Ownership check: non-admin users can only delete their own chats
  const user = await getCurrentUser();
  if (user && user.role !== "admin") {
    const chat = await getChat(chatId);
    if (chat?.userId && chat.userId !== user.id) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const deleted = await deleteChat(chatId);
  if (!deleted) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  return Response.json({ success: true });
}
