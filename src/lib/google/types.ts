/** What the Google service says about this workspace's connection. */
export interface GoogleStatus {
  connected: boolean;
  /** The Google account that is connected. */
  email?: string;
  /** Whether the agent can work with spreadsheets. */
  sheets: boolean;
  /** `on` when events can be written, `consent` when the account has to be connected again to allow it, `off` where the deployment offers no calendar. */
  calendar: "on" | "consent" | "off";
  /** Where the person goes to connect: the workspace's own address. */
  connectUrl: string;
}

export type SheetCell = string | number | boolean | null;

export interface SheetSummary {
  spreadsheetId: string;
  title: string;
  url: string;
  createdAt?: string;
}

/** A time as Google takes it: a whole day, or a moment with its zone. */
export type GoogleEventTime = { date: string } | { dateTime: string; timeZone?: string };

export interface GoogleEventInput {
  title: string;
  start: GoogleEventTime;
  end: GoogleEventTime;
  location?: string;
  description?: string;
  reminderMinutes?: number[];
  recurrence?: string[];
}

export interface GoogleEventSummary {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  url?: string;
}
