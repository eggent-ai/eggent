/**
 * Turning what a process wrote into what a page can show, and a page's text
 * into something a process can be given.
 *
 * Pure functions, so the browser and the tests read the same ones.
 */
import { TERMINAL_LIMITS } from "@/lib/terminal/protocol";

// CSI sequences (colours, cursor moves), OSC sequences (window titles, links)
// and the two-character escapes. Written out because a plain `[@-~]` after an
// escape would also eat the first letter of ordinary text following a lone one.
const ESCAPE_SEQUENCES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// Everything that is a control character and not a tab, newline or carriage return.
const OTHER_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripEscapes(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, "");
}

/**
 * What the screen would show once carriage returns and backspaces have done
 * their work. Progress bars rewrite one line a hundred times; shown as they were
 * written they are a hundred lines, and the last one is the only true one.
 */
export function settleLines(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      let settled = line;
      if (settled.includes("\u0008")) {
        // Inside a character class `\b` is a backspace, outside one it is a word
        // boundary, so the character is spelled out.
        let previous: string;
        do {
          previous = settled;
          settled = settled.replace(/[^\u0008]\u0008/g, "");
        } while (settled !== previous);
        settled = settled.replace(/\u0008/g, "");
      }
      if (!settled.includes("\r")) return settled;
      let shown = "";
      for (const part of settled.split("\r")) {
        if (part === "") continue;
        shown = part + shown.slice(part.length);
      }
      return shown;
    })
    .join("\n");
}

export interface FormattedOutput {
  text: string;
  /** Lines dropped from the top to keep the view to `maxLines`. */
  hiddenLines: number;
}

export function formatOutput(raw: string, maxLines = 400): FormattedOutput {
  const clean = settleLines(stripEscapes(raw)).replace(OTHER_CONTROLS, "").replace(/\n+$/, "");
  const lines = clean.split("\n");
  if (lines.length <= maxLines) return { text: clean, hiddenLines: 0 };
  return { text: lines.slice(lines.length - maxLines).join("\n"), hiddenLines: lines.length - maxLines };
}

const SHELL_LANGUAGES = new Set(["bash", "sh", "shell", "zsh", "shellscript"]);
const SESSION_LANGUAGES = new Set(["console", "shell-session", "shellsession", "terminal"]);

/**
 * The command a code block in an answer would run, or null when it is not one.
 *
 * A block gets a Run button only when somebody clearly meant it to be run: a
 * shell block, or a transcript where every line is a prompt followed by a
 * command. A `console` block that mixes commands with the output they printed
 * is *not* runnable - running it would send the output to the shell as more
 * commands.
 */
export function runnableCommand(code: string, language: string | undefined): string | null {
  const name = (language ?? "").toLowerCase();
  const isShell = SHELL_LANGUAGES.has(name);
  const isSession = SESSION_LANGUAGES.has(name);
  if (!isShell && !isSession) return null;

  const lines = code.replace(/\r\n/g, "\n").split("\n");
  const filled = lines.filter((line) => line.trim() !== "");
  if (filled.length === 0) return null;

  const prompted = filled.every((line) => /^\s*\$ /.test(line));
  if (isSession && !prompted) return null;
  const command = (prompted ? lines.map((line) => line.replace(/^\s*\$ /, "")) : lines).join("\n").trim();

  if (!command || command.length > TERMINAL_LIMITS.maxCommandChars) return null;
  // Nothing but comments is a note, not something to run.
  if (command.split("\n").every((line) => line.trim() === "" || line.trim().startsWith("#"))) return null;
  return command;
}

export type ShellInput =
  /** `!ls` - run `ls` here instead of sending the message. */
  | { kind: "command"; command: string }
  /** `!!hello` - a message that really starts with an exclamation mark. */
  | { kind: "literal"; text: string };

/**
 * A message that starts with `!` is a command for the shell, not for the agent;
 * `!!` is the way to say a message that starts with one.
 */
export function parseShellInput(text: string): ShellInput | null {
  if (text.startsWith("!!")) return { kind: "literal", text: text.slice(1) };
  if (text.startsWith("!")) return { kind: "command", command: text.slice(1).trim() };
  return null;
}

/**
 * Text as a Markdown code block that cannot be broken out of.
 *
 * What a command printed may itself contain a fence, and a fence of the same
 * length would end the block early and turn the rest into prose - which an
 * agent would then read as part of the message.
 */
export function fencedBlock(text: string, language = ""): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

/** The end of a long text, cut at a line so no line is half of one. */
export function lastChars(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const tail = text.slice(text.length - max);
  const newline = tail.indexOf("\n");
  return { text: newline === -1 ? tail : tail.slice(newline + 1), cut: true };
}

/** Short and stable: names a block of code within one message. */
export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}
