// A question card is plain text, but an agent puts links in it: the sign-in
// link to a Telegram bot is the step the whole daily-digest flow waits on, and
// as plain text it could only be copied by hand. This splits a question into
// text and links - a markdown link `[label](https://...)` or a bare web
// address - and nothing else. Only http(s) becomes a link.

export type QuestionPiece =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

const LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'`]+)/g;
// Punctuation that ends a sentence is not part of the address before it.
const TRAILING = /[.,;:!?…»)\]]+$/;

export function questionPieces(question: string): QuestionPiece[] {
  const pieces: QuestionPiece[] = [];
  let last = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const previous = pieces[pieces.length - 1];
    if (previous?.kind === "text") previous.text += text;
    else pieces.push({ kind: "text", text });
  };
  for (const match of question.matchAll(LINK)) {
    const start = match.index ?? 0;
    pushText(question.slice(last, start));
    if (match[1] !== undefined && match[2] !== undefined) {
      pieces.push({ kind: "link", text: match[1], href: match[2] });
      last = start + match[0].length;
      continue;
    }
    const raw = match[3] ?? "";
    const tail = raw.match(TRAILING)?.[0] ?? "";
    const href = raw.slice(0, raw.length - tail.length);
    if (href.length > "https://".length) pieces.push({ kind: "link", text: href, href });
    else pushText(href);
    pushText(tail);
    last = start + match[0].length;
  }
  pushText(question.slice(last));
  return pieces;
}
