export type UiSyncTopic = "projects" | "chat" | "files" | "board" | "global";

export interface UiSyncEvent {
  id: number;
  topic: UiSyncTopic;
  at: string;
  projectId?: string | null;
  chatId?: string;
  reason?: string;
  /** For a file event: the files it is about, by their path under the projects folder. */
  paths?: string[];
}

