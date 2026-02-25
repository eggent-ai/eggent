import type { AppSettings } from "@/lib/types";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Search the web using configured provider
 */
export async function searchWeb(
  query: string,
  limit: number,
  searchConfig: AppSettings["search"]
): Promise<string> {
  try {
    switch (searchConfig.provider) {
      case "searxng":
        return await searchSearxng(query, limit, searchConfig);
      case "tavily":
        return await searchTavily(query, limit, searchConfig);
      default:
        return "Search is not configured. Please set up a search provider in settings.";
    }
  } catch (error) {
    return `Search error: ${error instanceof Error ? error.message : String(error)}`;
  }
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

  return formatResults(results, query);
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
    return "Tavily API key not configured.";
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
  output += formatResults(results, query);
  return output;
}

function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return `No search results found for: "${query}"`;
  }

  const formatted = results
    .map(
      (r, i) =>
        `[${i + 1}] **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`
    )
    .join("\n\n");

  return `Search results for "${query}":\n\n${formatted}`;
}
