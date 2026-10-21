import { sendVersionForApproval } from "@/lib/approvals/client";
import { readFileForApproval, versionNumberOf, type ReadFailure } from "@/lib/approvals/files";
import type { Approval, ApprovalPeopleAnswer } from "@/lib/approvals/types";
import { watchApproval } from "@/lib/approvals/watch";
import { squashName } from "@/lib/pi/project-mention";

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
  const raw = (wanted || "").trim();
  if (!raw) return { error: "Name a person: an id or a name from people." };
  const byId = people.find((person) => person.id === raw);
  if (byId) return { person: byId };
  const key = squashName(raw);
  const exact = people.filter((person) => squashName(person.name) === key);
  if (exact.length === 1) return { person: exact[0] };
  const starts = people.filter((person) => {
    const words = person.name.split(/\s+/).map((word) => squashName(word));
    return squashName(person.name).startsWith(key) || words.includes(key);
  });
  if (starts.length === 1) return { person: starts[0] };
  const names = people.map((person) => `${person.name} (${person.id})`).join(", ") || "nobody";
  return {
    error: starts.length > 1 || exact.length > 1
      ? `More than one person fits "${raw}": ${names}. Ask which one, or use the id.`
      : `Nobody called "${raw}" is in the company. The people are: ${names}.`,
  };
}
