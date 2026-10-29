/** Small formatting shared by the Mail screens. Client-safe. */

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatWhen(iso: string, locale: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return sameDay(at, new Date()) ? time : `${at.toLocaleDateString(locale, { day: "numeric", month: "short" })}, ${time}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function senderName(letter: { from: { address: string | null; name: string | null } }): string {
  return letter.from.name || letter.from.address || "?";
}
