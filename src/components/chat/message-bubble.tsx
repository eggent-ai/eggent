"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot } from "lucide-react";
import { CodeBlock } from "./code-block";
import { ToolOutput } from "./tool-output";
import { ToolGroup } from "./tool-group";
import { SubagentGroup, type HelperItem } from "./subagent-group";
import { isAgentToolName, isProjectToolName } from "@/lib/pi/subagent-format";
import type { SubagentSnapshot } from "@/lib/pi/types";
import { FileMention } from "./file-mention";
import { StickyCopyButton, UserMessageFooter } from "./user-message-footer";
import { LearnedNote } from "./learned-note";
import { FilesProduced } from "./files-produced";
import { SendToContact, useMailReply } from "@/components/mail/mail-reply";
import { cleanProducedGroups, type ProducedGroup } from "@/lib/files/produced-shape";
import type { LearnedNotice } from "@/lib/learning/types";
import { embeddedAudioPath, embeddedImageUrl, fileMentionPath } from "@/lib/files/openable";
import { hashText, runnableCommand } from "@/lib/terminal/format";
import { resolveProjectMention } from "@/lib/pi/project-mention";
import { useAppStore } from "@/store/app-store";
import { useMemo, type ReactNode } from "react";
import type { UIMessage } from "ai";

interface MessageBubbleProps {
  message: UIMessage;
  /**
   * Names this message within its conversation, so a code block's run is still
   * the same run after the chat redraws. Absent where a message is shown out of
   * context and its blocks should not offer to run.
   */
  shellScope?: string;
}

/**
 * The person's own words, with a leading @project marked when it is understood
 * as one: the same reading the server makes, so a pill means the message was
 * handed to that project and a plain @word means it was not.
 */
function UserText({ text }: { text: string }) {
  const projects = useAppStore((state) => state.projects);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const mention = useMemo(() => {
    if (!text.startsWith("@")) return null;
    const resolution = resolveProjectMention(
      text,
      projects.map(({ id, name, description }) => ({ id, name, description })),
      activeProjectId
    );
    return resolution.kind === "project" ? resolution : null;
  }, [text, projects, activeProjectId]);
  if (!mention) return <>{text}</>;
  return (
    <>
      <span className="rounded bg-primary/10 px-1 font-medium text-primary" title={mention.project.name}>
        @{mention.handle}
      </span>
      {text.slice(1 + mention.handle.length)}
    </>
  );
}

function normalizeVisibleText(text: string): string {
  const noInvisible = text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  return noInvisible.trim();
}

function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function toolPartInfo(part: UIMessage["parts"][number]): {
  toolName: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
} | null {
  if (part.type === "dynamic-tool") {
    return part as {
      toolName: string;
      toolCallId?: string;
      state?: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
    };
  }

  if (!part.type.startsWith("tool-")) return null;
  const typedPart = part as {
    type: string;
    toolCallId?: string;
    state?: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
  };
  return {
    toolName: typedPart.type.replace("tool-", ""),
    toolCallId: typedPart.toolCallId,
    state: typedPart.state,
    input: typedPart.input,
    output: typedPart.output,
    errorText: typedPart.errorText,
  };
}

function renderMarkdownBlock(content: string, key: string, scope?: string) {
  const visible = normalizeVisibleText(content);
  if (!visible) return null;
  return (
    <div
      key={key}
      className="prose prose-sm dark:prose-invert max-w-none text-inherit [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
    >
      <MarkdownContent content={visible} scope={scope} />
    </div>
  );
}

// The avatar is 32px and sits at the top of the row, so its centre line is 16px
// down. A line of text is 28px tall (leading-7) starting 2px down, so it centres
// at 16px too and the two agree without help. A tool card does not: its header is
// 36px inside a 1px border, centring 21px down. Nudge the avatar by the 5px
// difference rather than shrinking the card, and only when a card is what the
// message opens with.
const AVATAR_TOOL_CARD_OFFSET = "mt-[5px]";

export function MessageBubble({ message, shellScope }: MessageBubbleProps) {
  const isUser = message.role === "user";
  // Before any return: a chat that answers a colleague's message offers to send each answer.
  const mailReply = useMailReply();

  if (isUser) {
    const visibleTextContent = normalizeVisibleText(
      message.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
    );

    if (!visibleTextContent) return null;
    // Taller than a screen or so: its copy button has to follow the reader down.
    const longMessage = visibleTextContent.length > 1200 || visibleTextContent.split("\n").length > 15;

    return (
      // The person's words sit in a grey box on the right and the answer runs
      // full width on the left, so who said what reads at a glance.
      <div className="group/user flex flex-col items-end py-2" data-message-role="user">
        <div
          className={`max-w-[85%] min-w-0 rounded-2xl bg-muted py-2 pl-4 text-sm leading-7 [overflow-wrap:anywhere] ${
            longMessage ? "pr-10" : "pr-4"
          }`}
        >
          {longMessage ? <StickyCopyButton text={visibleTextContent} /> : null}
          <p className="whitespace-pre-wrap"><UserText text={visibleTextContent} /></p>
        </div>
        <UserMessageFooter text={visibleTextContent} createdAt={messageCreatedAt(message)} />
      </div>
    );
  }

  // Consecutive tool calls are collected so they can be shown as one collapsed
  // row instead of a stack of boxes. Rendering of an individual call is
  // unchanged; only the grouping around it is new.
  const renderedParts: ReactNode[] = [];
  let pendingTools: { node: ReactNode; name: string; running: boolean }[] = [];
  // Helpers started with the Agent tool get their own group: each one is a whole
  // agent at work, and what it is doing is the thing to show while it runs.
  let pendingHelpers: HelperItem[] = [];
  const helperProgress = subagentSnapshots(message.parts);
  // Which of the two the avatar has to line up with; decided by the first block
  // that actually renders, since an empty text part draws nothing.
  let opensWithToolCard = false;
  let openingBlockDecided = false;
  const renderBlock = (content: string, key: string) => renderMarkdownBlock(content, key, shellScope);

  const noteOpeningBlock = (isToolCard: boolean) => {
    if (openingBlockDecided) return;
    openingBlockDecided = true;
    opensWithToolCard = isToolCard;
  };

  const flushHelpers = () => {
    if (!pendingHelpers.length) return;
    const group = pendingHelpers;
    pendingHelpers = [];
    noteOpeningBlock(true);
    renderedParts.push(
      <SubagentGroup
        key={`helpers-${group[0].toolCallId}`}
        items={group}
        renderMarkdown={renderBlock}
      />
    );
  };

  const flushTools = () => {
    flushHelpers();
    if (!pendingTools.length) return;
    const group = pendingTools;
    pendingTools = [];

    noteOpeningBlock(true);

    // A single call is not a fence; leave it as it was.
    if (group.length === 1) {
      renderedParts.push(group[0].node);
      return;
    }

    renderedParts.push(
      <ToolGroup
        key={`tools-${renderedParts.length}`}
        count={group.length}
        running={group.some((item) => item.running)}
        names={group.map((item) => item.name)}
      >
        {group.map((item) => item.node)}
      </ToolGroup>
    );
  };

  message.parts.forEach((part, idx) => {
    if (part.type === "text") {
      flushTools();
      const block = renderBlock(part.text, `text-${idx}`);
      if (block) {
        renderedParts.push(block);
        noteOpeningBlock(false);
      }
      return;
    }

    const tool = toolPartInfo(part);
    if (!tool) return;

    const input =
      typeof tool.input === "object" && tool.input !== null
        ? (tool.input as Record<string, unknown>)
        : {};

    // A scheduled Agent call registers a job and returns; it is not a helper
    // at work in this message, so it stays an ordinary tool card.
    const projectCall = isProjectToolName(tool.toolName);
    if (projectCall || (isAgentToolName(tool.toolName) && !(typeof input.schedule === "string" && input.schedule.trim()))) {
      // At most one of the two groups is ever open: starting either closes the other.
      if (pendingTools.length) flushTools();
      pendingHelpers.push({
        toolCallId: tool.toolCallId || `agent-${idx}`,
        ...(projectCall ? { kind: "project" as const } : {}),
        input,
        toolState:
          tool.state === "output-available" ? "output" : tool.state === "output-error" ? "error" : "running",
        // A live failure carries its text in errorText; a stored one in output.
        output: tool.output ?? tool.errorText,
        snapshot: tool.toolCallId ? helperProgress.get(tool.toolCallId) : undefined,
      });
      return;
    }
    flushHelpers();

    if (tool.toolName === "response" && tool.state === "output-available") {
      flushTools();
      const block = renderBlock(valueToText(tool.output), `response-${tool.toolCallId || idx}`);
      if (block) {
        renderedParts.push(block);
        noteOpeningBlock(false);
      }
      return;
    }

    pendingTools.push({
      name: tool.toolName,
      running: tool.state !== "output-available" && tool.state !== "output-error",
      node: (
        <ToolOutput
          key={`tool-${tool.toolCallId || idx}-${idx}`}
          toolName={tool.toolName}
          args={
            typeof tool.input === "object" && tool.input !== null
              ? (tool.input as Record<string, unknown>)
              : {}
          }
          result={
            tool.state === "output-available"
              ? valueToText(tool.output)
              : tool.state === "output-error"
                ? valueToText(tool.output) || "Error occurred"
                : "Running..."
          }
        />
      ),
    });
  });
  flushTools();

  if (!renderedParts.some(Boolean)) return null;
  const learned = learnedNoticeOf(message.parts);
  const producedFiles = producedFilesOf(message.parts);

  return (
    <div className="flex items-start gap-3 py-2" data-message-role="assistant">
      <div
        className={`flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background ${
          opensWithToolCard ? AVATAR_TOOL_CARD_OFFSET : ""
        }`}
      >
        <Bot className="size-4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3 pt-0.5 text-sm leading-7">
        {renderedParts}
        {producedFiles.length > 0 ? <FilesProduced groups={producedFiles} /> : null}
        {learned ? <LearnedNote notice={learned} /> : null}
        {/* Only once the answer is complete: the scope is withheld from the one still streaming. */}
        {mailReply && shellScope ? (
          <SendToContact
            info={mailReply}
            answerKey={`${shellScope}:${message.id}`}
            text={finalAnswerText(message.parts)}
            produced={producedFiles}
          />
        ) : null}
      </div>
    </div>
  );
}

/** When the person sent it: stored chats carry it as metadata, a new message gets it at send time. */
function messageCreatedAt(message: UIMessage): string | undefined {
  const metadata = message.metadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const value = (metadata as { createdAt?: unknown }).createdAt;
  return typeof value === "string" ? value : undefined;
}

/**
 * What an answer says once its work is done: the text after its last tool
 * call, or all of its text when it called none. What goes to a colleague is
 * the answer, not the narration on the way to it.
 */
function finalAnswerText(parts: UIMessage["parts"]): string {
  let lastTool = -1;
  parts.forEach((part, index) => {
    if (toolPartInfo(part)) lastTool = index;
  });
  const texts = parts
    .slice(lastTool + 1)
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean);
  if (texts.length) return texts.join("\n\n");
  return parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** The files this answer made, when it made any: the row under it. */
function producedFilesOf(parts: UIMessage["parts"]): ProducedGroup[] {
  for (const part of parts) {
    const candidate = part as { type?: string; data?: unknown };
    if (candidate.type !== "data-eggentFiles") continue;
    const data = candidate.data;
    return cleanProducedGroups(data);
  }
  return [];
}

/** What the agent saved after this answer, when it saved anything. */
function learnedNoticeOf(parts: UIMessage["parts"]): LearnedNotice | null {
  for (const part of parts) {
    const candidate = part as { type?: string; data?: unknown };
    if (candidate.type !== "data-eggentLearned") continue;
    const data = candidate.data as LearnedNotice | null | undefined;
    if (data && typeof data === "object" && Array.isArray(data.items) && data.items.length > 0) return data;
  }
  return null;
}

/** The latest progress each helper reported, by the Agent call it belongs to. */
function subagentSnapshots(parts: UIMessage["parts"]): Map<string, SubagentSnapshot> {
  const snapshots = new Map<string, SubagentSnapshot>();
  for (const part of parts) {
    const candidate = part as { type?: string; data?: unknown };
    if (candidate.type !== "data-piSubagent") continue;
    const data = candidate.data as SubagentSnapshot | null | undefined;
    if (data && typeof data === "object" && typeof data.toolCallId === "string") {
      snapshots.set(data.toolCallId, data);
    }
  }
  return snapshots;
}

function MarkdownContent({ content, scope }: { content: string; scope?: string }) {
  // The orchestrator is a project like any other on the file API; the store
  // spells it null and the API spells it "none".
  const projectId = useAppStore((state) => state.activeProjectId) ?? "none";
  // Built once per project rather than on every render. react-markdown uses
  // these functions as component types, so a fresh object each time remounted
  // everything they drew - every file mention in the answer - whenever the chat
  // re-rendered, and the window regaining focus was enough. A link flashed back
  // to plain code; a recording stopped mid-play.
  const components = useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || "");
      const isInline = !match;
      if (isInline) {
        // `site/preview.html` in an answer is where the work landed, and it
        // was a piece of text: find the panel, expand the folder, click,
        // land in the editor, find Open. Five steps to see your own page.
        const mention =
          typeof children === "string" || (Array.isArray(children) && children.every((c) => typeof c === "string"))
            ? fileMentionPath(Array.isArray(children) ? children.join("") : children)
            : null;
        if (mention) {
          return (
            <FileMention projectId={projectId} path={mention}>
              {children}
            </FileMention>
          );
        }
        return (
          <code
            className="bg-muted px-1.5 py-0.5 rounded text-sm"
            {...props}
          >
            {children}
          </code>
        );
      }
      const code = String(children).replace(/\n$/, "");
      // A shell block in an answer can be run from here; anything else is
      // shown, not offered. The key is the block's own, within this message,
      // so the run is still there when the history sync redraws the chat.
      const command = scope ? runnableCommand(code, match[1]) : null;
      return (
        <CodeBlock
          code={code}
          language={match[1]}
          command={command}
          runKey={command && scope ? `blk:${scope}:${hashText(command)}` : undefined}
        />
      );
    },
    a({ href, children, ...props }) {
      // `[listen](tts/take-1.mp3)` is a recording in the project; left to
      // the browser it resolves against /dashboard/<chatId>, exactly like
      // an embedded image did.
      const audioPath = typeof href === "string" ? embeddedAudioPath(href) : null;
      if (audioPath) {
        return (
          <FileMention projectId={projectId} path={audioPath} fallback={<span>{children}</span>}>
            {children}
          </FileMention>
        );
      }
      const external = /^https?:\/\//i.test(href || "");
      return (
        <a
          {...props}
          href={href}
          // Nothing marked links as links: they inherited body colour and
          // the theme has no accent to borrow. Weight and an underline do
          // the job in both themes. Long URLs wrap instead of overflowing
          // the bubble.
          className="break-words font-medium text-foreground underline decoration-foreground/40 underline-offset-2 transition-colors hover:decoration-foreground"
          // Anything off-site opens beside the chat, so following a link
          // never costs the conversation.
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          {children}
        </a>
      );
    },
    ul({ children, ...props }) {
      return (
        <ul className="my-2 list-disc pl-6 space-y-1" {...props}>
          {children}
        </ul>
      );
    },
    ol({ children, ...props }) {
      return (
        <ol className="my-2 list-decimal pl-6 space-y-1" {...props}>
          {children}
        </ol>
      );
    },
    li({ children, ...props }) {
      return (
        <li className="marker:text-muted-foreground" {...props}>
          {children}
        </li>
      );
    },
    img({ src, alt, ...props }) {
      if (!src) return null;
      // `![take 1](tts/take-1.mp3)`: an embedded recording plays, the way
      // an embedded picture shows.
      const audioPath = typeof src === "string" ? embeddedAudioPath(src) : null;
      if (audioPath) {
        const label = alt || audioPath.split("/").pop() || audioPath;
        return (
          <FileMention projectId={projectId} path={audioPath} fallback={<span>{label}</span>}>
            {label}
          </FileMention>
        );
      }
      return (
        <img
          // A relative src is a file in the project the agent works in;
          // left to the browser it resolves against /dashboard/<chatId>.
          src={typeof src === "string" ? embeddedImageUrl(src, projectId) ?? src : src}
          alt={alt || ""}
          className="my-3 max-h-96 max-w-full rounded-lg border object-contain"
          loading="lazy"
          {...props}
        />
      );
    },
    table({ children, ...props }) {
      return (
        <div className="my-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[520px] border-collapse text-sm" {...props}>
            {children}
          </table>
        </div>
      );
    },
    thead({ children, ...props }) {
      return (
        <thead className="bg-muted/60" {...props}>
          {children}
        </thead>
      );
    },
    tbody({ children, ...props }) {
      return (
        <tbody className="[&_tr:last-child_td]:border-b-0" {...props}>
          {children}
        </tbody>
      );
    },
    tr({ children, ...props }) {
      return (
        <tr className="border-b border-border/70" {...props}>
          {children}
        </tr>
      );
    },
    th({ children, ...props }) {
      return (
        <th
          className="border-r border-border/70 px-3 py-2 text-left font-semibold text-foreground last:border-r-0"
          {...props}
        >
          {children}
        </th>
      );
    },
    td({ children, ...props }) {
      return (
        <td
          className="border-r border-border/70 px-3 py-2 align-top text-foreground/90 last:border-r-0"
          {...props}
        >
          {children}
        </td>
      );
    },
  }), [projectId, scope]);

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
