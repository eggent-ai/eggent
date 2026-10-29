import { notFound } from "next/navigation";
import { EmailLetterView } from "@/components/email/email-letter-view";
import { EmailPageShell } from "@/components/email/email-page-shell";

/** One letter of the agent's mailbox. */
export default async function EmailLetterPage({ params }: { params: Promise<{ letterId: string }> }) {
  const { letterId } = await params;
  if (!/^\d{1,15}$/.test(letterId)) notFound();
  return (
    <EmailPageShell>
      <EmailLetterView key={letterId} letterId={Number(letterId)} />
    </EmailPageShell>
  );
}
