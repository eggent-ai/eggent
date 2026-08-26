"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, User } from "lucide-react";
import { CodeBlock } from "./code-block";
import { ToolOutput } from "./tool-output";
import { ToolGroup } from "./tool-group";
import type { ReactNode } from "react";
import type { UIMessage } from "ai";

interface MessageBubbleProps {
  message: UIMessage;
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
} | null {
  if (part.type === "dynamic-tool") {
    return part as {
      toolName: string;
      toolCallId?: string;
      state?: string;
      input?: unknown;
      output?: unknown;
    };
  }

  if (!part.type.startsWith("tool-")) return null;
  const typedPart = part as {
    type: string;
    toolCallId?: string;
    state?: string;
    input?: unknown;
    output?: unknown;
  };
  return {
    toolName: typedPart.type.replace("tool-", ""),
    toolCallId: typedPart.toolCallId,
    state: typedPart.state,
    input: typedPart.input,
    output: typedPart.output,
  };
}

function renderMarkdownBlock(content: string, key: string) {
  const visible = normalizeVisibleText(content);
  if (!visible) return null;
  return (
    <div
      key={key}
      className="prose prose-sm dark:prose-invert max-w-none text-inherit [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
    >
      <MarkdownContent content={visible} />
    </div>
  );
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    const visibleTextContent = normalizeVisibleText(
      message.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
    );

    if (!visibleTextContent) return null;

    return (
      <div className="flex items-start gap-3 py-2" data-message-role="user">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <User className="size-4" />
        </div>
        <div className="min-w-0 flex-1 pt-0.5 text-sm leading-7">
          <p className="whitespace-pre-wrap">{visibleTextContent}</p>
        </div>
      </div>
    );
  }

  // Consecutive tool calls are collected so they can be shown as one collapsed
  // row instead of a stack of boxes. Rendering of an individual call is
  // unchanged; only the grouping around it is new.
  const renderedParts: ReactNode[] = [];
  let pendingTools: { node: ReactNode; name: string; running: boolean }[] = [];

  const flushTools = () => {
    if (!pendingTools.length) return;
    const group = pendingTools;
    pendingTools = [];

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
      renderedParts.push(renderMarkdownBlock(part.text, `text-${idx}`));
      return;
    }

    const tool = toolPartInfo(part);
    if (!tool) return;

    if (tool.toolName === "response" && tool.state === "output-available") {
      flushTools();
      renderedParts.push(renderMarkdownBlock(valueToText(tool.output), `response-${tool.toolCallId || idx}`));
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

  return (
    <div className="flex items-start gap-3 py-2" data-message-role="assistant">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
        <Bot className="size-4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3 pt-0.5 text-sm leading-7">
        {renderedParts}
      </div>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          const isInline = !match;
          if (isInline) {
            return (
              <code
                className="bg-muted px-1.5 py-0.5 rounded text-sm"
                {...props}
              >
                {children}
              </code>
            );
          }
          return (
            <CodeBlock
              code={String(children).replace(/\n$/, "")}
              language={match[1]}
            />
          );
        },
        a({ href, children, ...props }) {
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
          return (
            <img
              src={src}
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
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
