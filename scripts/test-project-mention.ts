/**
 * Reading `@project do this`.
 *
 * Pure text in, a verdict out, so every rule that matters is a line here: what
 * counts as a name, what is not a mention, and what is ambiguous. Run with
 * Node 22: npm run test:project-mention
 */
import assert from "node:assert/strict";
import { mentionHandleFor, resolveProjectMention, squashName, suggestProjects, type MentionableProject } from "../src/lib/pi/project-mention.ts";

let failed = 0;
let ran = 0;
function check(name: string, fn: () => void): void {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const shop: MentionableProject = { id: "shop", name: "Online Shop" };
const blog: MentionableProject = { id: "blog", name: "Blog" };
const shopEu: MentionableProject = { id: "shop-eu", name: "Shop EU" };
// A project made in another language: a random id, and a name with the Russian
// yo in it, written as escapes so this file carries no Russian (the readable
// cases live in the Russian branch's own test).
const YOLKA = "\u0401\u043b\u043a\u0430";
const yolka: MentionableProject = { id: "3f9a1c2e", name: YOLKA };
const projects = [shop, blog, shopEu, yolka];

const project = (text: string, current?: string | null) => resolveProjectMention(text, projects, current);

console.log("What is a mention\n");

check("a name at the start, then the task", () => {
  const result = project("@Blog write a post about autumn");
  assert.equal(result.kind, "project");
  if (result.kind === "project") {
    assert.equal(result.project.id, "blog");
    assert.equal(result.task, "write a post about autumn");
  }
});

check("the id works as well as the name", () => {
  const result = project("@shop how many orders came back?");
  assert.equal(result.kind, "project");
  if (result.kind === "project") assert.equal(result.project.id, "shop");
});

check("a name with a space, written however the person likes", () => {
  for (const text of ["@Online Shop what is open?", "@online-shop what is open?", "@onlineshop what is open?", "@ONLINE_SHOP what is open?"]) {
    const result = project(text);
    assert.equal(result.kind, "project", text);
    if (result.kind === "project") assert.equal(result.project.id, "shop", text);
  }
});

check("a name with the Russian yo matches however it is written, although its id is random", () => {
  const result = project("@\u0435\u043b\u043a\u0430 do the accounts");
  assert.equal(result.kind, "project");
  if (result.kind === "project") {
    assert.equal(result.project.id, "3f9a1c2e");
    assert.equal(result.task, "do the accounts");
  }
  assert.equal(project(`@${YOLKA.toUpperCase()}: do it`).kind, "project");
});

check("a colon or a comma may stand between the name and the task", () => {
  for (const text of ["@Blog: new post", "@Blog, new post", "@Blog   new post"]) {
    const result = project(text);
    assert.equal(result.kind, "project", text);
    if (result.kind === "project") assert.equal(result.task, "new post", text);
  }
});

check("invisible characters pasted in front do not hide it", () => {
  assert.equal(project("​@Blog new post").kind, "project");
  assert.equal(project("  \n@Blog new post").kind, "project");
});

console.log("\nWhat is not\n");

check("a message that does not start with @", () => {
  assert.equal(project("ask @Blog to write a post").kind, "none");
  assert.equal(project("mail me at team@blog.example").kind, "none");
});

check("a handle that is not a project - a Telegram username, a person, a channel", () => {
  assert.equal(project("@someone_else hello").kind, "none");
  assert.equal(project("@mychannel post this").kind, "none");
});

check("a project's name only as the start of a longer word", () => {
  assert.equal(project("@blogging tips for today").kind, "none");
  assert.equal(project("@shopping list for friday").kind, "none");
});

check("a mention with nothing after it is not a task", () => {
  assert.equal(project("@Blog").kind, "none");
  assert.equal(project("@Blog   ").kind, "none");
  assert.equal(project("@").kind, "none");
});

console.log("\nWhich project when more than one fits\n");

check("the longer name wins: shop-eu is not shop", () => {
  const result = project("@shop-eu close the quarter");
  assert.equal(result.kind, "project");
  if (result.kind === "project") assert.equal(result.project.id, "shop-eu");
  const plain = project("@shop close the quarter");
  assert.equal(plain.kind, "project");
  if (plain.kind === "project") assert.equal(plain.project.id, "shop");
});

check("an id beats a name that reads the same", () => {
  const twins = [{ id: "reports", name: "Misc" }, { id: "misc", name: "Reports" }];
  const result = resolveProjectMention("@reports summarise", twins);
  assert.equal(result.kind, "project");
  if (result.kind === "project") assert.equal(result.project.id, "reports");
});

check("two projects with one name are ambiguous, and both are named", () => {
  const twins = [{ id: "a1", name: "Shop" }, { id: "b2", name: "shop" }];
  const result = resolveProjectMention("@Shop do it", twins);
  assert.equal(result.kind, "ambiguous");
  if (result.kind === "ambiguous") assert.deepEqual(result.candidates.map((p) => p.id).sort(), ["a1", "b2"]);
});

console.log("\nThe project the person is already in\n");

check("is not asked: the prefix goes and the task stays", () => {
  const result = project("@Blog write a post", "blog");
  assert.equal(result.kind, "self");
  if (result.kind === "self") assert.equal(result.task, "write a post");
});

console.log("\nOffering names while typing\n");

check("names and ids that start with what was typed", () => {
  assert.deepEqual(suggestProjects("bl", projects).map((p) => p.id), ["blog"]);
  assert.deepEqual(suggestProjects("sh", projects).map((p) => p.id), ["shop-eu"].concat([]).length ? ["shop", "shop-eu"] : []);
  assert.deepEqual(suggestProjects("", projects).length, 4);
  assert.deepEqual(suggestProjects("\u0435\u043b", projects).map((p) => p.id), ["3f9a1c2e"]);
});

check("what is offered is what would resolve", () => {
  for (const offered of suggestProjects("o", projects)) {
    assert.equal(resolveProjectMention(`@${offered.name} go`, projects).kind, "project", offered.name);
  }
});

check("squashing is idempotent and ignores what people do not mean", () => {
  assert.equal(squashName("My  Shop"), squashName("my-shop"));
  assert.equal(squashName(squashName(`${YOLKA}_${YOLKA}`)), squashName(`${YOLKA}_${YOLKA}`));
});

console.log("\nWriting a handle\n");

check("a name with spaces becomes one word, and resolves to its project", () => {
  const handle = mentionHandleFor(shop, projects);
  assert.equal(handle, "Online-Shop");
  const result = project(`@${handle} count orders`);
  assert.ok(result.kind === "project" && result.project.id === "shop");
});
check("every project's handle resolves to itself", () => {
  for (const candidate of projects) {
    const result = project(`@${mentionHandleFor(candidate, projects)} do it`);
    assert.ok(result.kind === "project" && result.project.id === candidate.id, candidate.id);
  }
});
check("when the name would be ambiguous the id is written", () => {
  const twins = [{ id: "shop", name: "Shop" }, { id: "shop-2", name: "Shop" }];
  assert.equal(mentionHandleFor(twins[1], twins), "shop-2");
  const result = resolveProjectMention("@shop-2 do it", twins);
  assert.ok(result.kind === "project" && result.project.id === "shop-2");
});
check("a name with a separator the grammar would stop at falls back to the id", () => {
  const odd = [{ id: "odd-one", name: "Sales, EU: orders" }];
  assert.equal(mentionHandleFor(odd[0], odd), "odd-one");
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
