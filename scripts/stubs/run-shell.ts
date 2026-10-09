/**
 * Stands in for the module that asks the agent SDK which shell to use.
 *
 * The real one loads the SDK, which a test of the terminal has no use for. What
 * it answers on a Unix machine with no settings is the same: bash, taking its
 * command as an argument.
 */
import fs from "node:fs";

export function resolveRunShell(): {
  shell: { path: string; args: string[]; commandFromStdin: boolean };
  commandPrefix: undefined;
} {
  return {
    shell: { path: fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", args: ["-c"], commandFromStdin: false },
    commandPrefix: undefined,
  };
}
