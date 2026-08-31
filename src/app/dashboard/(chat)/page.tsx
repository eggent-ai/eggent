import { ChatRouteSync } from "@/components/chat/chat-route-sync"

export const dynamic = "force-dynamic"

/**
 * `/dashboard` - the composer with no conversation in it yet.
 *
 * The project is deliberately left alone: starting a new chat from inside a
 * project starts it in that project, which is what the sidebar has always done.
 */
export default function NewChatPage() {
  return <ChatRouteSync chatId={null} />
}
