import { notFound } from "next/navigation"
import { ChatRouteSync } from "@/components/chat/chat-route-sync"
import { isReservedDashboardSegment } from "@/lib/dashboard-routes"
import { getChat } from "@/lib/storage/chat-store"

export const dynamic = "force-dynamic"

/**
 * `/dashboard/<chatId>` - one conversation, openable from a link.
 *
 * The project comes from the stored chat, because everything else on the screen
 * reads it: which chats the sidebar lists, which files the tree shows, and
 * which working directory the next message runs in. Arriving with a link and
 * typing before that was resolved would send the message to the wrong project.
 *
 * A name that belongs to the dashboard is refused outright. Next already keeps
 * `/dashboard/settings` on the settings page, but a directory with no page of
 * its own - `pipeline-runs`, which exists only as `[id]` underneath - has
 * nothing to win with, and would otherwise arrive here and become an empty
 * conversation named after it. It was a 404 before this route existed and it
 * stays one.
 *
 * An id with no chat behind it is not an error and must not reset the project.
 * It is the ordinary shape of a chat that does not exist *yet*: the first
 * message names the conversation on the client and the address follows
 * immediately, which can outrun the request that creates it. A link to a chat
 * that was deleted lands in the same place - an empty composer under that id -
 * and the next message simply starts the conversation there.
 */
export default async function ChatPage({
  params,
}: {
  params: Promise<{ chatId: string }>
}) {
  const { chatId } = await params
  if (isReservedDashboardSegment(chatId)) notFound()

  const chat = await getChat(chatId)

  if (!chat) return <ChatRouteSync chatId={chatId} />
  return <ChatRouteSync chatId={chat.id} projectId={chat.projectId ?? null} />
}
