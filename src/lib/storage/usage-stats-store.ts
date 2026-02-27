import fs from "fs/promises";
import path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserDailyStats {
  /** ISO date string YYYY-MM-DD */
  date: string;
  messageCount: number;
  /** Estimated token usage (rough count based on message length / 4) */
  estimatedTokens: number;
}

export interface UserUsageStats {
  userId: string;
  /** Daily stats keyed by date YYYY-MM-DD */
  daily: Record<string, UserDailyStats>;
  /** Lifetime totals */
  totalMessages: number;
  totalEstimatedTokens: number;
  updatedAt: string;
}

interface UsageStatsFile {
  users: Record<string, UserUsageStats>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), "data");
const STATS_FILE = path.join(DATA_DIR, "settings", "usage-stats.json");

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function ensureDir() {
  await fs.mkdir(path.dirname(STATS_FILE), { recursive: true });
}

async function readStatsFile(): Promise<UsageStatsFile> {
  try {
    const content = await fs.readFile(STATS_FILE, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const file = parsed as UsageStatsFile;
      if (file.users && typeof file.users === "object") return file;
    }
  } catch {
    // file missing or corrupt
  }
  return { users: {} };
}

async function writeStatsFile(data: UsageStatsFile): Promise<void> {
  await ensureDir();
  await fs.writeFile(STATS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

/** Remove daily entries older than 90 days to keep the file compact. */
function pruneOldEntries(stats: UserUsageStats): void {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const dateKey of Object.keys(stats.daily)) {
    if (dateKey < cutoffStr) {
      delete stats.daily[dateKey];
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a message exchange for a user. Call this after a successful
 * chat message + agent response cycle.
 */
export async function recordMessageUsage(params: {
  userId: string;
  userMessageLength: number;
  assistantMessageLength: number;
}): Promise<void> {
  const { userId, userMessageLength, assistantMessageLength } = params;
  const data = await readStatsFile();

  if (!data.users[userId]) {
    data.users[userId] = {
      userId,
      daily: {},
      totalMessages: 0,
      totalEstimatedTokens: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  const stats = data.users[userId];
  const today = todayKey();

  if (!stats.daily[today]) {
    stats.daily[today] = {
      date: today,
      messageCount: 0,
      estimatedTokens: 0,
    };
  }

  const tokens = estimateTokens(
    " ".repeat(userMessageLength) + " ".repeat(assistantMessageLength)
  );

  stats.daily[today].messageCount += 1;
  stats.daily[today].estimatedTokens += tokens;
  stats.totalMessages += 1;
  stats.totalEstimatedTokens += tokens;
  stats.updatedAt = new Date().toISOString();

  pruneOldEntries(stats);
  data.users[userId] = stats;
  await writeStatsFile(data);
}

/**
 * Get usage stats for a specific user.
 */
export async function getUserUsageStats(
  userId: string
): Promise<UserUsageStats | null> {
  const data = await readStatsFile();
  return data.users[userId] ?? null;
}

/**
 * Get usage stats for all users (admin view).
 */
export async function getAllUsageStats(): Promise<UserUsageStats[]> {
  const data = await readStatsFile();
  return Object.values(data.users);
}

/**
 * Get today's message count for a user (for quota checking).
 */
export async function getTodayMessageCount(userId: string): Promise<number> {
  const data = await readStatsFile();
  const stats = data.users[userId];
  if (!stats) return 0;
  const today = todayKey();
  return stats.daily[today]?.messageCount ?? 0;
}

/**
 * Get current month's estimated token usage for a user (for quota checking).
 */
export async function getCurrentMonthTokens(userId: string): Promise<number> {
  const data = await readStatsFile();
  const stats = data.users[userId];
  if (!stats) return 0;

  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  let total = 0;
  for (const [dateKey, daily] of Object.entries(stats.daily)) {
    if (dateKey.startsWith(monthPrefix)) {
      total += daily.estimatedTokens;
    }
  }
  return total;
}

/**
 * Check if a user has exceeded their daily message quota.
 * Returns true if the user CAN send a message (under quota or unlimited).
 */
export async function checkDailyQuota(
  userId: string,
  dailyLimit: number
): Promise<boolean> {
  if (dailyLimit <= 0) return true; // 0 = unlimited
  const count = await getTodayMessageCount(userId);
  return count < dailyLimit;
}

/**
 * Check if a user has exceeded their monthly token quota.
 * Returns true if the user CAN send a message (under quota or unlimited).
 */
export async function checkMonthlyTokenQuota(
  userId: string,
  monthlyLimit: number
): Promise<boolean> {
  if (monthlyLimit <= 0) return true; // 0 = unlimited
  const tokens = await getCurrentMonthTokens(userId);
  return tokens < monthlyLimit;
}
