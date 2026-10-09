"use client";

/**
 * The panels on the right of every dashboard screen: the terminal, and beside
 * it the files. Each screen mounts them together so a page cannot carry one
 * without the other - a header button that opens nothing on some screens is
 * worse than no button.
 */
import { FilesPanel } from "@/components/files-panel";
import { TerminalPanel } from "@/components/terminal-panel";

export function SidePanels() {
  return (
    <>
      <TerminalPanel />
      <FilesPanel />
    </>
  );
}
