"use client";

import { Suspense, use } from "react";
import { PublicChat } from "@/components/public-chat/public-chat";

/** A project's public link: anybody may open it; lib/public-chat decides what they may see. */
export default function PublicLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return (
    <Suspense>
      <PublicChat token={decodeURIComponent(token)} />
    </Suspense>
  );
}
