import assert from "node:assert/strict";
import { questionPieces } from "@/lib/question-links";

const links = (q: string) => questionPieces(q).filter((p) => p.kind === "link");
const text = (q: string) => questionPieces(q).map((p) => p.text).join("");
let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log("ok", name); };

check("bare address becomes a link", () => {
  const l = links("Open https://t.me/eggentai_bot?start=link_ABC_12-x and press Start.");
  assert.equal(l.length, 1);
  assert.equal(l[0].kind === "link" && l[0].href, "https://t.me/eggentai_bot?start=link_ABC_12-x");
});
check("trailing punctuation stays text", () => {
  assert.equal(text("See https://example.test/a). Next"), "See https://example.test/a). Next");
  const l = links("See https://example.test/a).");
  assert.equal(l[0].kind === "link" && l[0].href, "https://example.test/a");
});
check("markdown link keeps its label", () => {
  const l = links("Press [open the bot](https://t.me/x?start=link_1) then Done");
  assert.equal(l.length, 1);
  assert.equal(l[0].text, "open the bot");
  assert.equal(l[0].kind === "link" && l[0].href, "https://t.me/x?start=link_1");
});
check("other schemes are not links", () => {
  assert.equal(links("javascript:alert(1) and [x](javascript:alert(1)) and file:///etc").length, 0);
});
check("no address leaves the text whole", () => {
  assert.deepEqual(questionPieces("Нажали Start в Telegram?"), [{ kind: "text", text: "Нажали Start в Telegram?" }]);
});
check("text around links is kept exactly", () => {
  const q = "a https://x.test/1, b [c](https://x.test/2) d";
  assert.equal(text(q).replace("c", "[c](https://x.test/2)"), q);
});
console.log(`${n} checks passed`);
