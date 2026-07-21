"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, User } from "lucide-react";
import { CodeBlock } from "./code-block";
import { ToolOutput } from "./tool-output";
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

function renderReasoningBlock(content: string, key: string, state?: string) {
  const visible = normalizeVisibleText(content);
  if (!visible) return null;
  const isStreaming = state === "streaming";
  return (
    <details
      key={key}
      open={isStreaming}
      className="rounded-xl border border-dashed border-border bg-muted/30 px-3 py-2 text-muted-foreground"
    >
      <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide">
        {isStreaming ? "Thinking…" : "Thinking"}
      </summary>
      <div className="prose prose-sm dark:prose-invert mt-2 max-w-none text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <MarkdownContent content={visible} />
      </div>
    </details>
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
      <div className="flex items-start gap-3 py-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <User className="size-4" />
        </div>
        <div className="min-w-0 flex-1 pt-0.5 text-sm leading-7">
          <p className="whitespace-pre-wrap">{visibleTextContent}</p>
        </div>
      </div>
    );
  }

  const renderedParts = message.parts.map((part, idx) => {
    if (part.type === "text") {
      return renderMarkdownBlock(part.text, `text-${idx}`);
    }

    if (part.type === "reasoning") {
      return renderReasoningBlock(part.text, `reasoning-${idx}`, part.state);
    }

    const tool = toolPartInfo(part);
    if (!tool) return null;

    if (tool.toolName === "response" && tool.state === "output-available") {
      return renderMarkdownBlock(valueToText(tool.output), `response-${tool.toolCallId || idx}`);
    }

    return (
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
    );
  });

  if (!renderedParts.some(Boolean)) return null;

  return (
    <div className="flex items-start gap-3 py-2">
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
