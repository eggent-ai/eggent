import type { AppSettings } from "@/lib/types";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const MAX_RESULTS = 10;
const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html";
const DDG_INSTANT_ENDPOINT = "https://api.duckduckgo.com/";

/**
 * Search the web using configured provider
 */
export async function searchWeb(
  query: string,
  limit: number,
  searchConfig: AppSettings["search"]
): Promise<string> {
  const cappedLimit = Math.max(1, Math.min(MAX_RESULTS, limit || 5));
  try {
    switch (searchConfig.provider) {
      case "auto":
        return await searchAuto(query, cappedLimit, searchConfig);
      case "duckduckgo":
        return await searchDuckDuckGo(query, cappedLimit);
      case "searxng":
        return await searchSearxng(query, cappedLimit, searchConfig);
      case "tavily":
        return await searchTavily(query, cappedLimit, searchConfig);
      default:
        return "Search is not configured. Please set up a search provider in settings.";
    }
  } catch (error) {
    return `Search error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function searchAuto(
  query: string,
  limit: number,
  config: AppSettings["search"]
): Promise<string> {
  const hasTavilyKey = Boolean(config.apiKey || process.env.TAVILY_API_KEY);
  const hasSearxngUrl = Boolean(config.baseUrl?.trim());

  if (hasTavilyKey) {
    try {
      return await searchTavily(query, limit, config);
    } catch {
      // Fall through to the next provider.
    }
  }

  if (hasSearxngUrl) {
    try {
      return await searchSearxng(query, limit, config);
    } catch {
      // Fall through to keyless fallback.
    }
  }

  return await searchDuckDuckGo(query, limit);
}

/**
 * Search using SearXNG instance
 */
async function searchSearxng(
  query: string,
  limit: number,
  config: AppSettings["search"]
): Promise<string> {
  const baseUrl = config.baseUrl || "http://localhost:8080";
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`SearXNG error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const results: SearchResult[] = (data.results || [])
    .slice(0, limit)
    .map((r: { title: string; url: string; content: string }) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));

  return formatResults(results, query, "SearXNG");
}

/**
 * Search using Tavily API
 */
async function searchTavily(
  query: string,
  limit: number,
  config: AppSettings["search"]
): Promise<string> {
  const apiKey = config.apiKey || process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("Tavily API key not configured.");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
      include_answer: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const results: SearchResult[] = (data.results || []).map(
    (r: { title: string; url: string; content: string }) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    })
  );

  let output = "";
  if (data.answer) {
    output += `**Quick Answer:** ${data.answer}\n\n`;
  }
  output += formatResults(results, query, "Tavily");
  return output;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16))
    );
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const parsed = new URL(
      rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl
    );
    const redirected = parsed.searchParams.get("uddg");
    if (redirected) return redirected;
  } catch {
    // Keep raw URL if it's already a direct destination.
  }
  return rawUrl;
}

function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRegex =
    /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
  const nextResultRegex =
    /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")[^>]*>/i;

  for (const match of html.matchAll(resultRegex)) {
    const attrs = match[1] ?? "";
    const title = decodeHtmlEntities(stripHtml(match[2] ?? ""));
    const hrefMatch = /\bhref="([^"]*)"/i.exec(attrs);
    const url = decodeDuckDuckGoUrl(decodeHtmlEntities(hrefMatch?.[1] ?? ""));

    const resultEnd = (match.index ?? 0) + match[0].length;
    const tail = html.slice(resultEnd);
    const nextResultIndex = tail.search(nextResultRegex);
    const scopedTail =
      nextResultIndex >= 0 ? tail.slice(0, nextResultIndex) : tail;
    const snippetMatch =
      /<(?:a|span)\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/(?:a|span)>/i.exec(
        scopedTail
      );
    const snippet = decodeHtmlEntities(stripHtml(snippetMatch?.[1] ?? ""));

    if (title && url) {
      results.push({ title, url, snippet });
    }
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function flattenInstantTopics(topics: unknown[], bucket: SearchResult[]) {
  for (const topic of topics) {
    if (!topic || typeof topic !== "object") continue;
    const record = topic as {
      Text?: unknown;
      FirstURL?: unknown;
      Topics?: unknown[];
    };
    if (Array.isArray(record.Topics)) {
      flattenInstantTopics(record.Topics, bucket);
      continue;
    }
    if (typeof record.Text === "string" && typeof record.FirstURL === "string") {
      bucket.push({
        title: record.Text.split(" - ")[0] || record.Text,
        url: record.FirstURL,
        snippet: record.Text,
      });
    }
  }
}

async function searchDuckDuckGo(query: string, limit: number): Promise<string> {
  const htmlUrl = new URL(DDG_HTML_ENDPOINT);
  htmlUrl.searchParams.set("q", query);

  try {
    const response = await fetch(htmlUrl.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo error: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const results = parseDuckDuckGoHtml(html, limit);
    if (results.length > 0) {
      return formatResults(results, query, "DuckDuckGo");
    }
  } catch {
    // Fallback to instant-answer API.
  }

  const instantUrl = new URL(DDG_INSTANT_ENDPOINT);
  instantUrl.searchParams.set("q", query);
  instantUrl.searchParams.set("format", "json");
  instantUrl.searchParams.set("no_html", "1");
  instantUrl.searchParams.set("skip_disambig", "1");

  const instantResponse = await fetch(instantUrl.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!instantResponse.ok) {
    throw new Error(
      `DuckDuckGo fallback error: ${instantResponse.status} ${instantResponse.statusText}`
    );
  }

  const data = (await instantResponse.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: unknown[];
  };

  const results: SearchResult[] = [];
  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      snippet: data.AbstractText,
    });
  }
  if (Array.isArray(data.RelatedTopics)) {
    flattenInstantTopics(data.RelatedTopics, results);
  }

  return formatResults(results.slice(0, limit), query, "DuckDuckGo");
}

function formatResults(
  results: SearchResult[],
  query: string,
  providerName?: string
): string {
  if (results.length === 0) {
    return `No search results found for: "${query}"`;
  }

  const header = providerName
    ? `Search results for "${query}" (${providerName}):`
    : `Search results for "${query}":`;

  const formatted = results
    .map(
      (r, i) =>
        `[${i + 1}] **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`
    )
    .join("\n\n");

  return `${header}\n\n${formatted}`;
}
