/**
 * The shell behind the terminal panel: how it starts and what it looks like.
 *
 * Bash only gets the start-up file below; anything else (`sh` as a fallback, a
 * shell somebody configured) is simply started interactively, since what a
 * prompt variable means differs between shells and a wrong guess prints garbage
 * on every line.
 *
 * The prompt is the project's name and the way down from it, not the machine's
 * name and an absolute path: inside a workspace container the host is a random
 * identifier and the path is a data directory nobody chose, and neither says
 * where in *their* project they are. A shell outside the project shows its real
 * path, because there the real path is the information.
 *
 * History is kept in the workspace's data folder. The home directory of a
 * container is gone with the next image, and a terminal whose up-arrow forgets
 * everything after every update is one people stop using for anything they
 * would have to type twice.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Single-quoted lines rather than a template literal: bash's `${...}` is also
// how a template literal interpolates, and the two do not mix.
const RC_FILE = [
  "# Written by Eggent for the terminal panel; the user's own start-up comes first.",
  'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
  "__eggent_where() {",
  '  local root="$EGGENT_TERMINAL_ROOT" name="${EGGENT_TERMINAL_ROOT##*/}"',
  '  if [ "$PWD" = "$root" ]; then',
  "    printf '%s' \"$name\"",
  '  elif [ "${PWD#"$root"/}" != "$PWD" ]; then',
  "    printf '%s/%s' \"$name\" \"${PWD#\"$root\"/}\"",
  "  else",
  "    printf '%s' \"$PWD\"",
  "  fi",
  "}",
  "PS1='\\[\\e[2m\\]$(__eggent_where)\\[\\e[0m\\] \\$ '",
  "HISTSIZE=5000",
  "HISTFILESIZE=5000",
  "",
].join("\n");

export interface InteractiveShell {
  path: string;
  args: string[];
  env: Record<string, string>;
}

function writeRcFile(): string | null {
  try {
    const dir = path.join(os.tmpdir(), "eggent-terminal");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "bashrc");
    // Replaced through a rename so a shell starting at the same moment never
    // reads half a file.
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, RC_FILE, { mode: 0o644 });
    fs.renameSync(temp, file);
    return file;
  } catch {
    return null;
  }
}

export function prepareInteractiveShell(shellPath: string, root: string, dataDir: string): InteractiveShell {
  const name = path.basename(shellPath).toLowerCase().replace(/\.exe$/, "");
  const rc = name === "bash" ? writeRcFile() : null;

  const env: Record<string, string> = {
    EGGENT_TERMINAL_ROOT: root,
    // macOS still ships bash 3.2 and nags about zsh on every start.
    BASH_SILENCE_DEPRECATION_WARNING: "1",
  };
  if (!process.env.LANG && !process.env.LC_ALL) {
    env.LANG = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  }
  try {
    const historyDir = path.join(dataDir, "terminal");
    fs.mkdirSync(historyDir, { recursive: true });
    env.HISTFILE = path.join(historyDir, `${name || "shell"}_history`);
  } catch {
    // No history is better than no terminal.
  }

  return {
    path: shellPath,
    args: name === "bash" && rc ? ["--rcfile", rc, "-i"] : ["-i"],
    env,
  };
}
