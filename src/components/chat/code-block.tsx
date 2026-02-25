"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const copiedOk = await copyTextToClipboard(code);
    if (!copiedOk) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group rounded-lg border bg-muted/50 overflow-hidden my-2">
      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/80">
        <span className="text-xs text-muted-foreground font-mono">
          {language || "code"}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={handleCopy}
          className="h-6 gap-1 text-xs"
        >
          {copied ? (
            <>
              <Check className="size-3" />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-3" />
              Copy
            </>
          )}
        </Button>
      </div>
      <pre className="p-3 overflow-x-auto text-sm">
        <code className={language ? `language-${language}` : ""}>
          {code}
        </code>
      </pre>
    </div>
  );
}
