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

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  // Extract text content from parts
  const textContent = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

  // Extract tool parts
  const toolParts = message.parts.filter(
    (p) => p.type.startsWith("tool-") || p.type === "dynamic-tool"
  );

  return (
    <div className="space-y-1">
      {/* Tool invocations */}
      {toolParts.map((part, idx) => {
        if (part.type === "dynamic-tool") {
          const dp = part as {
            type: "dynamic-tool";
            toolName: string;
            toolCallId: string;
            state: string;
            input?: unknown;
            output?: unknown;
          };
          return (
            <ToolOutput
              key={`tool-${dp.toolCallId}-${idx}`}
              toolName={dp.toolName}
              args={
                typeof dp.input === "object" && dp.input !== null
                  ? (dp.input as Record<string, unknown>)
                  : {}
              }
              result={
                dp.state === "output-available"
                  ? typeof dp.output === "string"
                    ? dp.output
                    : JSON.stringify(dp.output)
                  : dp.state === "output-error"
                    ? "Error occurred"
                    : "Running..."
              }
            />
          );
        }
        // Handle typed tool parts (tool-{name})
        if (part.type.startsWith("tool-")) {
          const tp = part as {
            type: string;
            toolCallId?: string;
            state?: string;
            input?: unknown;
            output?: unknown;
          };
          const toolName = part.type.replace("tool-", "");
          return (
            <ToolOutput
              key={`tool-${tp.toolCallId || idx}-${idx}`}
              toolName={toolName}
              args={
                typeof tp.input === "object" && tp.input !== null
                  ? (tp.input as Record<string, unknown>)
                  : {}
              }
              result={
                tp.state === "output-available"
                  ? typeof tp.output === "string"
                    ? tp.output
                    : JSON.stringify(tp.output)
                  : tp.state === "output-error"
                    ? "Error occurred"
                    : "Running..."
              }
            />
          );
        }
        return null;
      })}

      {/* Text content: same font size for user and AI, first line aligned with icon center */}
      {textContent && (
        <div className="flex gap-3 py-2 items-start">
          <div
            className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
              isUser
                ? "bg-secondary text-secondary-foreground"
                : "bg-foreground text-background"
            }`}
          >
            {isUser ? (
              <User className="size-4" />
            ) : (
              <Bot className="size-4" />
            )}
          </div>
          <div className="flex-1 min-w-0 text-sm leading-7 pt-0.5">
            {isUser ? (
              <p className="whitespace-pre-wrap">{textContent}</p>
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none text-inherit [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <MarkdownContent content={textContent} />
              </div>
            )}
          </div>
        </div>
      )}
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
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
