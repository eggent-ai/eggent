/**
 * What an employee's chat is called: its task and what it was given, short -
 * "Marketer's task: shop.example", so the project (named by the role) and its
 * chats do not read the same, and two jobs of one employee can be told apart.
 */
export function jobTitle(task: string, kind: string, input: string | undefined, filePath?: string): string {
  let what = "";
  if (filePath) what = filePath.split(/[\\/]/).pop() || "";
  else if (input && kind === "url") {
    try {
      what = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`).hostname.replace(/^www\./, "");
    } catch {
      what = input;
    }
  } else if (input) what = input;
  what = what.replace(/\s+/g, " ").trim();
  if (what.length > 40) what = `${what.slice(0, 39).trimEnd()}…`;
  return what ? `${task}: ${what}` : task;
}
