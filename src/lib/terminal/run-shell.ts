/**
 * Which shell a command runs in.
 *
 * The one the agent's own bash tool uses, from the same settings: a command
 * somebody runs by hand has to behave exactly like the one the agent would have
 * run, or "it works when I click it" and "it works when the agent runs it" are
 * two different claims. That includes the optional command prefix a workspace
 * configures (an environment to load, say) and, on Windows, where Git Bash is.
 *
 * Kept apart from the registry so the registry stays free of the agent SDK and
 * can be tested on its own.
 */
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { getPiSettingsManager } from "@/lib/pi/config-store";
import type { ShellSpec } from "@/lib/terminal/registry";

export interface RunShell {
  shell: ShellSpec;
  commandPrefix?: string;
}

export function resolveRunShell(cwd: string): RunShell {
  const settings = getPiSettingsManager(cwd);
  const config = getShellConfig(settings.getShellPath());
  return {
    shell: {
      path: config.shell,
      args: config.args,
      commandFromStdin: config.commandTransport === "stdin",
    },
    commandPrefix: settings.getShellCommandPrefix() || undefined,
  };
}
