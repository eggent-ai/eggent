export type UiSyncTopic = "projects" | "chat" | "files" | "global";

export interface UiSyncEvent {
  id: number;
  topic: UiSyncTopic;
  at: string;
  projectId?: string | null;
  chatId?: string;
  reason?: string;
}

