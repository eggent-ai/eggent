/**
 * Reading a message for what it wants done with schedules.
 *
 * Kept apart from the chat runner because it is pure text in, tool names out:
 * no runtime, no workspace, no model. That is what makes it testable, and this
 * logic has already shipped one defect that only a test would have caught.
 */
export function hasScheduleManagementIntent(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsSchedules =
    /\b(scheduled|schedule|schedules|reminders?|jobs?)\b/.test(normalized) ||
    /(запланирован|расписани|напоминани|задач)/i.test(text);
  const managementVerb =
    /\b(cancel|delete|remove|clear|list|show|what|which|update|change|move|reschedule|edit)\b/.test(normalized) ||
    /(убери|удали|отмени|очисти|покажи|выведи|какие|список|измени|поменяй|перенеси|сдвинь|обнови)/i.test(text);
  const changesScheduledTime =
    (/\b(update|change|move|reschedule)\b/.test(normalized) || /(измени|поменяй|перенеси|сдвинь|обнови)/i.test(text))
    && /\b\d{1,2}(?::|\s)\d{2}\b/.test(text);
  return (mentionsSchedules && managementVerb) || changesScheduledTime;
}

export function hasScheduleIntent(text: string): boolean {
  if (hasScheduleManagementIntent(text)) return false;
  const normalized = text.toLowerCase();
  return (
    /\b(in|after)\s+\d+\s*(seconds?|secs?|minutes?|mins?|hours?|days?)\b/.test(normalized) ||
    /\b(tomorrow|tonight|daily|weekly|monthly|every\s+\w+|remind\s+me|schedule)\b/.test(normalized) ||
    /\b(at)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/.test(normalized) ||
    /через\s+\d+\s*(секунд[уы]?|сек\.?|минут[уы]?|мин\.?|час(а|ов)?|дн(я|ей)?)/i.test(text) ||
    /(завтра|послезавтра|сегодня\s+в|напомни|напомнить|по\s+расписанию|кажд(ый|ую|ое)|ежедневно|еженедельно)/i.test(text)
  );
}

/**
 * Which tools this turn may use, decided from scratch every turn.
 *
 * Managing schedules and creating them want different tool sets: a request to
 * list or cancel must go through eggent_manage_schedules, so Agent and bash are
 * withheld, or the model edits the store by hand and the armed cron keeps the
 * old time.
 *
 * This used to subtract from whatever survived the previous turn and only ever
 * added `bash` back, so `Agent` - the one tool that creates a schedule - was
 * gone for good after a single management turn. Asking for the list and then
 * asking for a new reminder produced "the scheduling tool is currently
 * unavailable", while the model poked at get_subagent_result looking for
 * something that was still installed and merely switched off. Three schedules
 * had been created in the same conversation minutes earlier.
 *
 * So the set is computed from the session's full tool list each time. Anything
 * withheld for one turn comes back on the next.
 */
export function applySchedulingToolPolicy(
  session: {
    getActiveToolNames: () => string[];
    setActiveToolsByName: (toolNames: string[]) => void;
    getAllTools?: () => Array<{ name: string }>;
    getToolDefinition?: (toolName: string) => unknown;
  },
  text: string
) {
  const activeTools = session.getActiveToolNames();
  // The full set is the baseline; without it we can only ever take away.
  const allTools = session.getAllTools?.().map((tool) => tool.name) ?? activeTools;
  const withheld = hasScheduleManagementIntent(text)
    ? new Set(["Agent", "bash"])
    : hasScheduleIntent(text)
      ? new Set(["bash"])
      : new Set<string>();

  const next = allTools.filter((toolName) => !withheld.has(toolName));
  const unchanged =
    next.length === activeTools.length && next.every((toolName) => activeTools.includes(toolName));
  if (unchanged) return;
  session.setActiveToolsByName(next);
}

