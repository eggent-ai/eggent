import type { AppSettings } from "@/lib/types";

export function updateSettingsByPath(
  settings: AppSettings,
  path: string,
  value: unknown
): AppSettings {
  const keys = path.split(".").filter(Boolean);
  if (keys.length === 0) return settings;

  const updated = structuredClone(settings) as unknown as Record<string, unknown>;
  let cursor: Record<string, unknown> = updated;

  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    const next = cursor[key];

    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      const replacement: Record<string, unknown> = {};
      cursor[key] = replacement;
      cursor = replacement;
      continue;
    }

    cursor = next as Record<string, unknown>;
  }

  cursor[keys[keys.length - 1]] = value;
  return updated as unknown as AppSettings;
}
