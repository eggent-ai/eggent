import { approvalsEnabled } from "@/lib/approvals/config";
import { fetchApprovalForKey, reportApprovalOutdated } from "@/lib/approvals/client";
import { absoluteInScope, currentStateOfKey, keyOfFile, versionNumberOf } from "@/lib/approvals/files";
import { APPROVAL_MAX_FILE_BYTES, approvalIsOpen, type Approval, type FileApprovalStatus } from "@/lib/approvals/types";
import { watchApproval } from "@/lib/approvals/watch";

/**
 * An approval as it stands once this workspace has looked at its file.
 *
 * The watch catches a change within a minute; a screen that shows an approval
 * of one's own file does not wait for it. When the file no longer holds the
 * newest round's version, the service is told before the answer is given, so
 * nobody is shown "on approval" or "approved" for a file that has moved on.
 */
export async function freshApproval(approval: Approval): Promise<Approval> {
  const latest = approval.rounds[0];
  if (!approval.mine || !approval.fileKey || !approvalIsOpen(approval) || !latest || latest.round !== approval.currentRound) {
    watchApproval(approval);
    return approval;
  }
  const now = await currentStateOfKey(approval.fileKey);
  if (now.kind === "file" && now.sha256 === latest.sha256) {
    watchApproval(approval);
    return approval;
  }
  const updated = await reportApprovalOutdated(approval.id, { round: latest.round, sha: now.kind === "file" ? now.sha256 : null });
  watchApproval(updated, approval.fileKey);
  return updated;
}

/** A file of this workspace and its approval, for the file's own screen. */
export async function fileApprovalStatus(projectId: string, filePath: string): Promise<{ status: FileApprovalStatus } | { error: "outside" }> {
  const absolute = absoluteInScope(projectId, filePath);
  const key = absolute ? await keyOfFile(absolute) : null;
  if (!absolute || !key) return { error: "outside" };
  const now = await currentStateOfKey(key);
  const current: FileApprovalStatus["current"] = {
    exists: now.kind !== "missing",
    sha256: now.kind === "file" ? now.sha256 : null,
    size: now.kind === "file" || now.kind === "tooLarge" ? now.size : 0,
    versionN: now.kind === "file" ? await versionNumberOf(absolute, now.sha256, { keep: false }) : null,
    tooLarge: now.kind === "tooLarge",
  };
  if (!approvalsEnabled()) {
    return { status: { enabled: false, approval: null, current, changedSinceSent: false, maxBytes: APPROVAL_MAX_FILE_BYTES } };
  }
  const found = await fetchApprovalForKey(key);
  const approval = found ? await freshApproval(found) : null;
  if (!approval) watchApproval(null, key);
  const latest = approval?.rounds[0];
  return {
    status: {
      enabled: true,
      approval,
      current,
      changedSinceSent: Boolean(latest && latest.sha256 !== current.sha256),
      maxBytes: APPROVAL_MAX_FILE_BYTES,
    },
  };
}
