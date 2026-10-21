/**
 * What is put into a copy of a page shown on screen - never into the file.
 *
 * The page runs in a sandboxed frame with no origin of its own, so the screen
 * around it can neither read it nor be read by it; the two talk only through
 * these scripts and `postMessage`, and the screen accepts messages only from
 * that frame.
 */

/**
 * Pointing at blocks and changing their words. A hovered block is outlined,
 * a click picks it (the screen hands it to the chat), a double click lets the
 * words in it be typed over. Only text may change: anything that adds or
 * removes an element while typing is put back and refused, because the file
 * is changed by replacing the characters of each piece of text where it is.
 * Every change names its piece by the element's number and its place among
 * that element's text, plus what it read before - the server checks both.
 */
export function editingScript(sha: string, nonce: string): string {
  const code = `(() => {
  const SHA = ${JSON.stringify(sha)};
  const post = (message) => parent.postMessage(Object.assign({ eggent: 1 }, message), "*");
  const host = document.createElement("eggent-overlay");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = '<style>.box{position:fixed;display:none;pointer-events:none;box-sizing:border-box;border-radius:3px}.hover{outline:2px dashed #2563eb;outline-offset:1px}.picked{outline:2px solid #2563eb;outline-offset:1px;background:rgba(37,99,235,.07)}.editing{outline:2px solid #16a34a;background:transparent}.tag{position:fixed;display:none;font:600 11px/18px system-ui,-apple-system,sans-serif;color:#fff;background:#2563eb;padding:0 6px;border-radius:3px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}</style><div class="box hover"></div><div class="box picked"></div><div class="tag"></div>';
  document.documentElement.appendChild(host);
  const hoverBox = root.querySelector(".hover");
  const pickedBox = root.querySelector(".picked");
  const chip = root.querySelector(".tag");
  let hovered = null;
  let picked = null;
  let editing = null;
  const numberOf = (el) => Number(el.getAttribute("data-eggent-el"));
  const numbered = (node) => {
    for (let n = node; n && n !== document.documentElement; n = n.parentNode) {
      if (n.nodeType === 1 && n.hasAttribute("data-eggent-el")) return n;
    }
    return null;
  };
  const label = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : el.classList && el.classList[0] ? "." + el.classList[0] : "");
  const place = (box, el) => {
    if (!el) { box.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px"; box.style.top = r.top + "px";
    box.style.width = r.width + "px"; box.style.height = r.height + "px";
  };
  const redraw = () => {
    place(hoverBox, hovered && hovered !== picked ? hovered : null);
    place(pickedBox, picked);
    pickedBox.classList.toggle("editing", Boolean(editing));
    const shown = hovered || picked;
    if (!shown) { chip.style.display = "none"; return; }
    const r = shown.getBoundingClientRect();
    chip.textContent = editing ? label(shown) + " \\u00b7 Enter / Esc" : label(shown);
    chip.style.display = "block";
    chip.style.left = Math.max(0, r.left) + "px";
    chip.style.top = (r.top > 22 ? r.top - 20 : Math.max(0, r.bottom + 2)) + "px";
  };
  let queued = false;
  const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; redraw(); }); } };
  addEventListener("scroll", later, true);
  addEventListener("resize", later);
  document.addEventListener("mousemove", (event) => {
    if (editing) return;
    const el = numbered(event.target);
    if (el !== hovered) { hovered = el; later(); }
  }, true);
  document.addEventListener("mouseleave", () => { hovered = null; later(); });
  // The text of every gap inside an element, keyed by the numbered element that holds it and the
  // number of children that are not text before it - the same key the server reads the file by.
  const gapsIn = (el) => {
    const gaps = new Map();
    const owners = [el].concat(Array.prototype.slice.call(el.querySelectorAll("[data-eggent-el]")));
    for (const owner of owners) {
      let slot = 0;
      for (const child of owner.childNodes) {
        if (child.nodeType === 3) {
          const key = numberOf(owner) + ":" + slot;
          gaps.set(key, (gaps.get(key) || "") + child.data);
        } else {
          slot += 1;
        }
      }
    }
    return gaps;
  };
  const structureOf = (el) => {
    const nodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    return nodes;
  };
  const refuse = (reason) => post({ type: "editRefused", reason: reason });
  const begin = (el, event) => {
    if (el.closest("script,style,textarea,select,option,iframe,object,svg,math,template")) { refuse("uneditable"); return; }
    if (el.querySelector("svg,math,iframe,object,textarea,select")) { refuse("uneditable"); return; }
    const before = gapsIn(el);
    if (!Array.from(before.values()).some((text) => text.trim())) { refuse("noText"); return; }
    try { el.contentEditable = "plaintext-only"; } catch (error) { el.contentEditable = "true"; }
    editing = { el: el, before: before, structure: structureOf(el), snapshot: el.innerHTML };
    hovered = null; picked = el; later();
    el.focus();
    const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(event.clientX, event.clientY) : null;
    if (range) { const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
    el.addEventListener("blur", finish, { once: true });
  };
  function stop(restore) {
    const current = editing;
    editing = null;
    current.el.removeAttribute("contenteditable");
    current.el.normalize();
    const now = structureOf(current.el);
    const changedStructure = now.length !== current.structure.length || now.some((node, index) => node !== current.structure[index]);
    if (restore || changedStructure) current.el.innerHTML = current.snapshot;
    later();
    return { current: current, changedStructure: changedStructure };
  }
  function finish() {
    if (!editing) return;
    const done = stop(false);
    if (done.changedStructure) { refuse("structure"); return; }
    const after = gapsIn(done.current.el);
    const keys = new Set(Array.from(done.current.before.keys()).concat(Array.from(after.keys())));
    const edits = [];
    keys.forEach((key) => {
      const was = done.current.before.get(key) || "";
      const text = after.get(key) || "";
      if (was === text) return;
      const parts = key.split(":");
      edits.push({ el: Number(parts[0]), slot: Number(parts[1]), was: was, text: text });
    });
    if (edits.length) post({ type: "edit", edits: edits, scrollY: scrollY });
  }
  function cancel() {
    if (!editing) return;
    editing.el.removeEventListener("blur", finish);
    stop(true);
  }
  document.addEventListener("keydown", (event) => {
    if (!editing) return;
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); editing.el.removeEventListener("blur", finish); finish(); }
    else if (event.key === "Escape") { event.preventDefault(); cancel(); }
  }, true);
  document.addEventListener("click", (event) => {
    if (editing) {
      if (editing.el.contains(event.target)) return;
      editing.el.removeEventListener("blur", finish);
      finish();
    }
    event.preventDefault();
    event.stopPropagation();
    const el = numbered(event.target);
    picked = el; later();
    post(el ? { type: "select", el: numberOf(el), label: label(el), text: (el.innerText || "").trim().slice(0, 160) } : { type: "select", el: null });
  }, true);
  document.addEventListener("dblclick", (event) => {
    if (editing) return;
    event.preventDefault();
    event.stopPropagation();
    const el = numbered(event.target);
    if (el) begin(el, event);
  }, true);
  document.addEventListener("submit", (event) => event.preventDefault(), true);
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.eggent !== 1) return;
    if (event.data.type === "scroll" && typeof event.data.y === "number") scrollTo(0, event.data.y);
    if (event.data.type === "clear") { picked = null; later(); }
  });
  post({ type: "ready", sha: SHA });
})();`;
  return `<script nonce="${nonce}">${code}</script>`;
}

/** Background colours and pictures as they are, and no block cut across two pages. */
export const PRINT_STYLE = `<style data-eggent-print>@page{margin:12mm}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}@media print{img,svg,video,canvas,figure,picture,table,pre,blockquote{break-inside:avoid}h1,h2,h3,h4,h5,h6{break-after:avoid}}</style>`;

/**
 * Getting a page ready to be saved as a PDF, then opening the print dialog:
 * whatever appears as it is scrolled to is scrolled to (with animations
 * stopped, so it arrives at once), pictures and fonts are waited for, and a
 * header that stays on screen is let go of, or it would cover every page.
 */
export function printScript(title: string): string {
  return `<script>(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const freeze = document.createElement("style");
  freeze.textContent = "*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important}";
  (document.head || document.documentElement).appendChild(freeze);
  if (!document.title) document.title = ${JSON.stringify(title)};
  if (document.readyState !== "complete") await new Promise((resolve) => addEventListener("load", resolve, { once: true }));
  document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = "eager"; });
  const step = Math.max(200, innerHeight * 0.8);
  for (let y = 0; y < document.documentElement.scrollHeight; y += step) { scrollTo(0, y); await wait(60); }
  scrollTo(0, 0);
  const pending = Array.from(document.images).filter((img) => !img.complete);
  await Promise.race([Promise.all(pending.map((img) => new Promise((resolve) => { img.addEventListener("load", resolve, { once: true }); img.addEventListener("error", resolve, { once: true }); }))), wait(5000)]);
  if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, wait(3000)]);
  for (const el of document.querySelectorAll("body *")) {
    const position = getComputedStyle(el).position;
    if (position === "fixed") el.style.setProperty("position", "absolute", "important");
    else if (position === "sticky") el.style.setProperty("position", "relative", "important");
  }
  await wait(150);
  print();
})();</script>`;
}
