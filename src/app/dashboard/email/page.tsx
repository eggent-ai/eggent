import { EmailLettersView } from "@/components/email/email-letters-view";
import { EmailPageShell } from "@/components/email/email-page-shell";

/** The agent's mailbox: Inbox by default, ?folder=other or sent. */
export default async function EmailPage({ searchParams }: { searchParams: Promise<{ folder?: string }> }) {
  const { folder } = await searchParams;
  return (
    <EmailPageShell>
      <EmailLettersView folder={typeof folder === "string" ? folder : "inbox"} />
    </EmailPageShell>
  );
}
