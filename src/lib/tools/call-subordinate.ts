import type { ModelMessage } from "ai";

/**
 * Delegate a task to a subordinate agent
 */
export async function callSubordinate(
  task: string,
  projectId: string | undefined,
  parentAgentNumber: number,
  parentHistory: ModelMessage[]
): Promise<string> {
  try {
    // Dynamic import to avoid circular dependency
    const { runSubordinateAgent } = await import("@/lib/agent/agent");

    const result = await runSubordinateAgent({
      task,
      projectId,
      parentAgentNumber,
      parentHistory,
    });

    return `Subordinate Agent ${parentAgentNumber + 1} completed the task:\n\n${result}`;
  } catch (error) {
    return `Subordinate agent error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
