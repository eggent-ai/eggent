import fs from "fs/promises";
import path from "path";
import { randomBytes } from "node:crypto";
import { hashPassword } from "@/lib/auth/password";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserRole = "admin" | "user";

export interface UserPermissions {
  chat: boolean;
  projects: boolean;
  knowledge: boolean;
  codeExecution: boolean;
  webSearch: boolean;
  fileUpload: boolean;
  imageGeneration: boolean;
  telegram: boolean;
}

export interface UserQuotas {
  /** 0 = unlimited */
  dailyMessageLimit: number;
  /** 0 = unlimited */
  monthlyTokenLimit: number;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
  mustChangePassword: boolean;
  permissions: UserPermissions;
  quotas: UserQuotas;
  telegramUserId: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/** User object without the password hash — safe for API responses. */
export type SafeUser = Omit<User, "passwordHash">;

interface UsersFile {
  users: User[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), "data");
const SETTINGS_DIR = path.join(DATA_DIR, "settings");
const USERS_FILE = path.join(SETTINGS_DIR, "users.json");

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PERMISSIONS: UserPermissions = {
  chat: true,
  projects: true,
  knowledge: true,
  codeExecution: true,
  webSearch: true,
  fileUpload: true,
  imageGeneration: true,
  telegram: true,
};

const DEFAULT_QUOTAS: UserQuotas = {
  dailyMessageLimit: 0,
  monthlyTokenLimit: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateUserId(): string {
  return `usr_${randomBytes(8).toString("hex")}`;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function stripPasswordHash(user: User): SafeUser {
  const { passwordHash: _, ...safe } = user;
  return safe;
}

// ---------------------------------------------------------------------------
// Persistence (read / write)
// ---------------------------------------------------------------------------

async function readUsersFile(): Promise<UsersFile> {
  await ensureDir(SETTINGS_DIR);
  try {
    const content = await fs.readFile(USERS_FILE, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as UsersFile).users)
    ) {
      return parsed as UsersFile;
    }
  } catch {
    // file missing or corrupt — fall through
  }
  return { users: [] };
}

async function writeUsersFile(data: UsersFile): Promise<void> {
  await ensureDir(SETTINGS_DIR);
  await fs.writeFile(USERS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Migration: bootstrap initial admin from legacy settings.auth
// ---------------------------------------------------------------------------

let migrationDone = false;

/**
 * Ensures at least one admin user exists. On the very first call it reads
 * the legacy `settings.json → auth` block and creates a matching admin user
 * in the users store, preserving the existing passwordHash and
 * mustChangeCredentials flag.
 */
async function ensureInitialized(): Promise<void> {
  if (migrationDone) return;

  const data = await readUsersFile();
  if (data.users.length > 0) {
    migrationDone = true;
    return;
  }

  // Read legacy settings to migrate from
  let legacyUsername = "admin";
  let legacyPasswordHash: string | undefined;
  let legacyMustChange = true;

  try {
    const settingsPath = path.join(SETTINGS_DIR, "settings.json");
    const raw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as {
      auth?: {
        username?: string;
        passwordHash?: string;
        mustChangeCredentials?: boolean;
      };
    };

    if (settings.auth) {
      if (settings.auth.username) legacyUsername = settings.auth.username;
      if (settings.auth.passwordHash)
        legacyPasswordHash = settings.auth.passwordHash;
      if (typeof settings.auth.mustChangeCredentials === "boolean")
        legacyMustChange = settings.auth.mustChangeCredentials;
    }
  } catch {
    // No settings file — use defaults
  }

  const now = new Date().toISOString();
  const adminUser: User = {
    id: generateUserId(),
    username: legacyUsername,
    displayName: legacyUsername.charAt(0).toUpperCase() + legacyUsername.slice(1),
    passwordHash: legacyPasswordHash || hashPassword("admin"),
    role: "admin",
    mustChangePassword: legacyMustChange,
    permissions: { ...DEFAULT_PERMISSIONS },
    quotas: { ...DEFAULT_QUOTAS },
    telegramUserId: null,
    createdAt: now,
    lastLoginAt: null,
  };

  data.users.push(adminUser);
  await writeUsersFile(data);
  migrationDone = true;
}

// ---------------------------------------------------------------------------
// Public API — Read
// ---------------------------------------------------------------------------

export async function getAllUsers(): Promise<SafeUser[]> {
  await ensureInitialized();
  const data = await readUsersFile();
  return data.users.map(stripPasswordHash);
}

export async function getUserById(id: string): Promise<User | null> {
  await ensureInitialized();
  const data = await readUsersFile();
  return data.users.find((u) => u.id === id) ?? null;
}

export async function getUserByUsername(
  username: string
): Promise<User | null> {
  await ensureInitialized();
  const data = await readUsersFile();
  const lower = username.toLowerCase();
  return data.users.find((u) => u.username.toLowerCase() === lower) ?? null;
}

export async function getUserByTelegramId(
  telegramUserId: string
): Promise<User | null> {
  await ensureInitialized();
  const data = await readUsersFile();
  return (
    data.users.find((u) => u.telegramUserId === telegramUserId) ?? null
  );
}

export async function getSafeUserById(id: string): Promise<SafeUser | null> {
  const user = await getUserById(id);
  return user ? stripPasswordHash(user) : null;
}

// ---------------------------------------------------------------------------
// Public API — Write
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  username: string;
  displayName?: string;
  password: string;
  role?: UserRole;
  permissions?: Partial<UserPermissions>;
  quotas?: Partial<UserQuotas>;
}

export async function createUser(input: CreateUserInput): Promise<SafeUser> {
  await ensureInitialized();

  const username = input.username.trim().toLowerCase();
  if (!username || username.length < 3 || username.length > 64) {
    throw new Error("Username must be 3-64 characters");
  }
  if (!/^[a-z0-9._-]+$/.test(username)) {
    throw new Error(
      "Username may only contain lowercase letters, numbers, dots, hyphens and underscores"
    );
  }

  const password = input.password.trim();
  if (password.length < 8 || password.length > 128) {
    throw new Error("Password must be 8-128 characters");
  }

  const data = await readUsersFile();
  if (data.users.some((u) => u.username.toLowerCase() === username)) {
    throw new Error("Username already exists");
  }

  const now = new Date().toISOString();
  const user: User = {
    id: generateUserId(),
    username,
    displayName:
      input.displayName?.trim() ||
      username.charAt(0).toUpperCase() + username.slice(1),
    passwordHash: hashPassword(password),
    role: input.role ?? "user",
    mustChangePassword: true,
    permissions: { ...DEFAULT_PERMISSIONS, ...(input.permissions ?? {}) },
    quotas: { ...DEFAULT_QUOTAS, ...(input.quotas ?? {}) },
    telegramUserId: null,
    createdAt: now,
    lastLoginAt: null,
  };

  data.users.push(user);
  await writeUsersFile(data);
  return stripPasswordHash(user);
}

export interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
  permissions?: Partial<UserPermissions>;
  quotas?: Partial<UserQuotas>;
  mustChangePassword?: boolean;
  telegramUserId?: string | null;
}

export async function updateUser(
  id: string,
  input: UpdateUserInput
): Promise<SafeUser | null> {
  await ensureInitialized();
  const data = await readUsersFile();
  const idx = data.users.findIndex((u) => u.id === id);
  if (idx === -1) return null;

  const user = data.users[idx];

  if (input.displayName !== undefined)
    user.displayName = input.displayName.trim();
  if (input.role !== undefined) user.role = input.role;
  if (input.mustChangePassword !== undefined)
    user.mustChangePassword = input.mustChangePassword;
  if (input.telegramUserId !== undefined)
    user.telegramUserId = input.telegramUserId;
  if (input.permissions)
    user.permissions = { ...user.permissions, ...input.permissions };
  if (input.quotas) user.quotas = { ...user.quotas, ...input.quotas };

  data.users[idx] = user;
  await writeUsersFile(data);
  return stripPasswordHash(user);
}

export async function updateUserPassword(
  id: string,
  newPassword: string
): Promise<boolean> {
  const password = newPassword.trim();
  if (password.length < 8 || password.length > 128) {
    throw new Error("Password must be 8-128 characters");
  }

  const data = await readUsersFile();
  const idx = data.users.findIndex((u) => u.id === id);
  if (idx === -1) return false;

  data.users[idx].passwordHash = hashPassword(password);
  data.users[idx].mustChangePassword = false;
  await writeUsersFile(data);
  return true;
}

export async function updateLastLogin(id: string): Promise<void> {
  const data = await readUsersFile();
  const idx = data.users.findIndex((u) => u.id === id);
  if (idx === -1) return;

  data.users[idx].lastLoginAt = new Date().toISOString();
  await writeUsersFile(data);
}

export async function deleteUser(id: string): Promise<boolean> {
  await ensureInitialized();
  const data = await readUsersFile();
  const idx = data.users.findIndex((u) => u.id === id);
  if (idx === -1) return false;

  const user = data.users[idx];

  // Prevent deleting the last admin
  if (user.role === "admin") {
    const adminCount = data.users.filter((u) => u.role === "admin").length;
    if (adminCount <= 1) {
      throw new Error("Cannot delete the last admin user");
    }
  }

  data.users.splice(idx, 1);
  await writeUsersFile(data);
  return true;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export async function countAdmins(): Promise<number> {
  await ensureInitialized();
  const data = await readUsersFile();
  return data.users.filter((u) => u.role === "admin").length;
}
