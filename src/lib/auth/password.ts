import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_KEY_LEN = 64;
const DEFAULT_SALT = "XLqs3H3hyIdkLImyxg8Trg";
const DEFAULT_HASH =
  "EJ6r0rW1FjbcfamS-XMzbzxQJklry49niFbCBDbldZZ8oo7oOTTwZyz8cFWLfb18lml72SPyA5KgLxdNm7tKPg";

export const DEFAULT_AUTH_USERNAME = "admin";
export const DEFAULT_AUTH_PASSWORD = "admin";
export const DEFAULT_AUTH_PASSWORD_HASH = `scrypt$${DEFAULT_SALT}$${DEFAULT_HASH}`;

export function isDefaultAuthCredentials(
  username: string,
  passwordHash: string
): boolean {
  return (
    username.trim() === DEFAULT_AUTH_USERNAME &&
    passwordHash.trim() === DEFAULT_AUTH_PASSWORD_HASH
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(input: string): Uint8Array | null {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function hashPassword(password: string): string {
  const trimmed = password.trim();
  if (!trimmed) {
    throw new Error("Password is required");
  }
  const salt = encodeBase64Url(randomBytes(16));
  const derived = scryptSync(trimmed, salt, SCRYPT_KEY_LEN);
  return `scrypt$${salt}$${encodeBase64Url(derived)}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }

  const salt = parts[1];
  const expected = decodeBase64Url(parts[2]);
  if (!expected) {
    return false;
  }

  try {
    const actual = scryptSync(password, salt, expected.length);
    if (actual.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
