"use client";

/**
 * A file's text, edited as code: line numbers, the language's colours, search,
 * undo, brackets that close themselves. CodeMirror 6, loaded only when a file
 * is opened, so the chat screen does not carry it.
 *
 * The text is the parent's (`value` / `onChange`): a newer text arriving from
 * outside replaces what is shown only when it differs, so typing is never
 * fought. Colours come from the app's own tokens (`--code-*` in globals.css),
 * so the editor follows the theme without a second palette.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { cn } from "@/lib/utils";

export interface CodeSelection {
  startLine: number;
  endLine: number;
  text: string;
}

export interface CodeEditorHandle {
  /** Selects a range of the text (offsets into it) and scrolls it into view. */
  select(from: number, to: number): void;
  focus(): void;
}

type Language = "html" | "css" | "javascript" | "typescript" | "json" | "markdown" | "python" | "xml" | "yaml" | null;

const LANGUAGE_BY_EXTENSION: Record<string, Language> = {
  html: "html", htm: "html", vue: "html", svelte: "html",
  css: "css", scss: "css", less: "css",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  json: "json", jsonc: "json", webmanifest: "json",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  py: "python",
  xml: "xml", svg: "xml", plist: "xml",
  yml: "yaml", yaml: "yaml",
};

// Prose reads better wrapped; code keeps its lines and scrolls sideways.
const WRAPPED = new Set(["md", "markdown", "mdx", "txt", "text", "csv", "log", "rtf", ""]);

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

export function languageOfFile(fileName: string): Language {
  return LANGUAGE_BY_EXTENSION[extensionOf(fileName)] ?? null;
}

/** The lines a selection covers and its text (at most 4000 characters), or null for none. */
function selectionIn(view: EditorView): CodeSelection | null {
  const { from, to } = view.state.selection.main;
  if (to <= from) return null;
  const text = view.state.sliceDoc(from, to);
  if (!text.trim()) return null;
  const startLine = view.state.doc.lineAt(from).number;
  // A selection that ends at the start of a line does not take that line.
  const endLine = view.state.doc.lineAt(text.endsWith("\n") ? Math.max(from, to - 1) : to).number;
  return { startLine, endLine, text: text.slice(0, 4000) };
}

async function loadEditor() {
  const [state, view, commands, language, search, autocomplete, highlight] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/commands"),
    import("@codemirror/language"),
    import("@codemirror/search"),
    import("@codemirror/autocomplete"),
    import("@lezer/highlight"),
  ]);
  const { tags } = highlight;
  const style = language.HighlightStyle.define([
    { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword], color: "var(--code-keyword)" },
    { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.attributeValue], color: "var(--code-string)" },
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--code-comment)", fontStyle: "italic" },
    { tag: [tags.tagName, tags.typeName, tags.className, tags.angleBracket], color: "var(--code-tag)" },
    { tag: [tags.attributeName, tags.propertyName, tags.definition(tags.propertyName)], color: "var(--code-attr)" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit, tags.color], color: "var(--code-number)" },
    { tag: [tags.heading, tags.strong], color: "var(--code-heading)", fontWeight: "600" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: [tags.link, tags.url], color: "var(--code-tag)", textDecoration: "underline" },
    { tag: [tags.meta, tags.processingInstruction, tags.documentMeta], color: "var(--code-comment)" },
    { tag: tags.invalid, color: "var(--destructive)" },
  ]);
  const theme = view.EditorView.theme({
    "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent", color: "var(--foreground)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.6" },
    ".cm-content": { caretColor: "var(--foreground)", paddingBlock: "8px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted-foreground)", border: "none" },
    ".cm-lineNumbers .cm-gutterElement": { paddingInline: "8px 6px", minWidth: "3ch" },
    ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 55%, transparent)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "color-mix(in oklch, var(--info) 28%, transparent)",
    },
    ".cm-selectionMatch": { backgroundColor: "color-mix(in oklch, var(--info) 14%, transparent)" },
    ".cm-matchingBracket, .cm-nonmatchingBracket": { backgroundColor: "color-mix(in oklch, var(--muted) 90%, transparent)", outline: "1px solid var(--border)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--warning) 25%, transparent)", outline: "1px solid var(--warning)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in oklch, var(--warning) 45%, transparent)" },
    ".cm-panels": { backgroundColor: "var(--card)", color: "var(--foreground)", borderColor: "var(--border)" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
    ".cm-panel input, .cm-panel button, .cm-panel label": { fontSize: "12px", fontFamily: "var(--font-sans), system-ui, sans-serif" },
    ".cm-textfield": { backgroundColor: "var(--background)", border: "1px solid var(--input)", borderRadius: "6px", color: "var(--foreground)" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "var(--background)", border: "1px solid var(--input)", borderRadius: "6px", color: "var(--foreground)" },
    ".cm-tooltip": { backgroundColor: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: "6px" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-foreground)" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--muted)", border: "none", color: "var(--muted-foreground)" },
  });
  return { state, view, commands, language, search, autocomplete, style, theme };
}

type Loaded = Awaited<ReturnType<typeof loadEditor>>;
let loading: Promise<Loaded> | null = null;
function editorModules(): Promise<Loaded> {
  if (!loading) loading = loadEditor();
  return loading;
}

async function languageExtension(lang: Language): Promise<Extension[]> {
  switch (lang) {
    case "html": return [(await import("@codemirror/lang-html")).html({ autoCloseTags: true })];
    case "css": return [(await import("@codemirror/lang-css")).css()];
    case "javascript": return [(await import("@codemirror/lang-javascript")).javascript({ jsx: true })];
    case "typescript": return [(await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true })];
    case "json": return [(await import("@codemirror/lang-json")).json()];
    case "markdown": return [(await import("@codemirror/lang-markdown")).markdown()];
    case "python": return [(await import("@codemirror/lang-python")).python()];
    case "xml": return [(await import("@codemirror/lang-xml")).xml()];
    case "yaml": return [(await import("@codemirror/lang-yaml")).yaml()];
    default: return [];
  }
}

export const CodeEditor = forwardRef<CodeEditorHandle, {
  value: string;
  onChange?: (value: string) => void;
  fileName: string;
  readOnly?: boolean;
  onSelectionChange?: (selection: CodeSelection | null) => void;
  /** Cmd/Ctrl+S. */
  onSave?: () => void;
  ariaLabel?: string;
  className?: string;
  /** A range to select and scroll to once the editor is ready; `key` makes the same range count again. */
  reveal?: { from: number; to: number; key: number } | null;
}>(function CodeEditor({ value, onChange, fileName, readOnly = false, onSelectionChange, onSave, ariaLabel, className, reveal }, ref) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const modules = useRef<Loaded | null>(null);
  const readOnlyCompartment = useRef<unknown>(null);
  // The latest callbacks, read by the editor's listeners without rebuilding it.
  const callbacks = useRef({ onChange, onSelectionChange, onSave });
  callbacks.current = { onChange, onSelectionChange, onSave };
  const [ready, setReady] = useState(false);

  useImperativeHandle(ref, () => ({
    select(from, to) {
      const view = viewRef.current;
      if (!view || !modules.current) return;
      const length = view.state.doc.length;
      const anchor = Math.max(0, Math.min(from, length));
      const head = Math.max(anchor, Math.min(to, length));
      view.dispatch({
        selection: { anchor, head },
        effects: modules.current.view.EditorView.scrollIntoView(anchor, { y: "center" }),
      });
      view.focus();
    },
    focus() {
      viewRef.current?.focus();
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    let created: EditorView | null = null;
    void (async () => {
      const loaded = await editorModules();
      const lang = await languageExtension(languageOfFile(fileName));
      if (cancelled || !host.current) return;
      modules.current = loaded;
      const { state, view, commands, language, search, autocomplete, style, theme } = loaded;
      const compartment = new state.Compartment();
      readOnlyCompartment.current = compartment;
      const extensions: Extension[] = [
        view.lineNumbers(),
        view.highlightActiveLineGutter(),
        view.highlightSpecialChars(),
        commands.history(),
        language.foldGutter(),
        view.drawSelection(),
        view.dropCursor(),
        state.EditorState.allowMultipleSelections.of(true),
        language.indentOnInput(),
        language.syntaxHighlighting(style),
        language.bracketMatching(),
        autocomplete.closeBrackets(),
        autocomplete.autocompletion(),
        view.highlightActiveLine(),
        search.highlightSelectionMatches(),
        view.keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => { callbacks.current.onSave?.(); return true; } },
          ...autocomplete.closeBracketsKeymap,
          ...commands.defaultKeymap,
          ...search.searchKeymap,
          ...commands.historyKeymap,
          ...language.foldKeymap,
          ...autocomplete.completionKeymap,
          commands.indentWithTab,
        ]),
        theme,
        ...lang,
        ...(WRAPPED.has(extensionOf(fileName)) ? [view.EditorView.lineWrapping] : []),
        compartment.of([state.EditorState.readOnly.of(readOnly), view.EditorView.editable.of(!readOnly)]),
        view.EditorView.contentAttributes.of({ "aria-label": ariaLabel || fileName, spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
        view.EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) callbacks.current.onSelectionChange?.(selectionIn(update.view));
        }),
      ];
      created = new view.EditorView({
        state: state.EditorState.create({ doc: value, extensions }),
        parent: host.current,
      });
      viewRef.current = created;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      created?.destroy();
      viewRef.current = null;
      setReady(false);
    };
    // A new file is a new editor; the text and the switches follow below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName]);

  // A text that came from outside - a reload, a newer version taken in.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value, ready]);

  useEffect(() => {
    const view = viewRef.current;
    const loaded = modules.current;
    if (!view || !loaded || !reveal) return;
    const length = view.state.doc.length;
    const anchor = Math.max(0, Math.min(reveal.from, length));
    const head = Math.max(anchor, Math.min(reveal.to, length));
    view.dispatch({ selection: { anchor, head }, effects: loaded.view.EditorView.scrollIntoView(anchor, { y: "center" }) });
    view.focus();
  }, [reveal, ready]);

  useEffect(() => {
    const view = viewRef.current;
    const loaded = modules.current;
    const compartment = readOnlyCompartment.current as { reconfigure: (extension: Extension) => unknown } | null;
    if (!view || !loaded || !compartment) return;
    view.dispatch({
      effects: compartment.reconfigure([loaded.state.EditorState.readOnly.of(readOnly), loaded.view.EditorView.editable.of(!readOnly)]) as never,
    });
  }, [readOnly, ready]);

  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring",
        className
      )}
    >
      <div ref={host} className={cn("h-full", !ready && "hidden")} />
      {!ready ? (
        // The text as it is, until the editor has loaded: nothing jumps, nothing is missing.
        <pre aria-hidden className="h-full overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[13px]/[1.6] text-muted-foreground">
          {value}
        </pre>
      ) : null}
    </div>
  );
});
