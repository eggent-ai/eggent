import { squashName } from "@/lib/pi/project-mention";

/** A person of the company by id, or by name the way people write it: "Ann", "ann ivanova", one word of it. */
export function resolveCompanyPerson<T extends { id: string; name: string }>(people: T[], wanted: string): { person: T } | { error: string } {
  const raw = (wanted || "").trim();
  if (!raw) return { error: "Name a person: an id or a name from people." };
  const byId = people.find((person) => person.id === raw);
  if (byId) return { person: byId };
  const key = squashName(raw);
  const exact = people.filter((person) => squashName(person.name) === key);
  if (exact.length === 1) return { person: exact[0] };
  const starts = people.filter((person) => {
    const words = person.name.split(/\s+/).map((word) => squashName(word));
    return squashName(person.name).startsWith(key) || words.includes(key);
  });
  if (starts.length === 1) return { person: starts[0] };
  const names = people.map((person) => `${person.name} (${person.id})`).join(", ") || "nobody";
  return {
    error: starts.length > 1 || exact.length > 1
      ? `More than one person fits "${raw}": ${names}. Ask which one, or use the id.`
      : `Nobody called "${raw}" is in the company. The people are: ${names}.`,
  };
}
