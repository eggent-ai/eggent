import { sendVersionForApproval } from "@/lib/approvals/client";
import { readFileForApproval, versionNumberOf, type ReadFailure } from "@/lib/approvals/files";
import type { Approval, ApprovalPeopleAnswer } from "@/lib/approvals/types";
import { watchApproval } from "@/lib/approvals/watch";
import { resolveCompanyPerson } from "@/lib/company/people";

/**
 * Sending a file of this workspace for approval, as the screen and the agent
 * both do it: the file read as it is this moment, its version kept in its
 * history and named by its number, the chain as given, and the file watched
 * from then on.
 */

export type SendFailure = ReadFailure;

export async function sendFileForApproval(input: {
  absolute: string;
  approvers: string[];
  note?: string;
  author: "person" | "agent";
}): Promise<{ approval: Approval } | { error: SendFailure }> {
  const read = await readFileForApproval(input.absolute);
  if ("error" in read) return read;
  const { file } = read;
  const versionN = await versionNumberOf(file.absolute, file.sha256, { keep: true });
  const approval = await sendVersionForApproval({
    key: file.key,
    fileName: file.name,
    mime: file.mime,
    data: file.data,
    versionN,
    approvers: input.approvers,
    note: input.note,
    author: input.author,
  });
  watchApproval(approval, file.key);
  return { approval };
}

type Person = ApprovalPeopleAnswer["people"][number];

/** A person of the company by id, or by name the way people write it: "Ann", "ann ivanova", one word of it. */
export function resolveApprovalPerson(people: Person[], wanted: string): { person: Person } | { error: string } {
  return resolveCompanyPerson(people, wanted);
}
