export const AUTH_COOKIE_NAME = "eggent_auth";
export const AUTH_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface AuthSessionPayload {
  username: string;
  issuedAt: number;
  expiresAt: number;
  mustChangeCredentials: boolean;
}

interface AuthSessionWirePayload {
  u: string;
  iat: number;
  exp: number;
  mcc?: 1;
}

function parseBooleanEnv(value: string | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return null;
}

function getSessionSecret(): string {
  return (
    process.env.EGGENT_AUTH_SECRET?.trim() ||
    "eggent-default-auth-secret-change-me"
  );
}

function utf8ToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToUtf8(value: Uint8Array): string {
  return new TextDecoder().decode(value);
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

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const keyBytes = Uint8Array.from(utf8ToBytes(secret));
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signPayload(payloadB64: string): Promise<string> {
  const key = await importHmacKey(getSessionSecret());
  const data = Uint8Array.from(utf8ToBytes(payloadB64));
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return encodeBase64Url(new Uint8Array(signature));
}

function safeEqual(left: string, right: string): boolean {
  const max = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < max; i += 1) {
    const l = left.charCodeAt(i) || 0;
    const r = right.charCodeAt(i) || 0;
    diff |= l ^ r;
  }
  return diff === 0;
}

export async function createSessionToken(
  username: string,
  mustChangeCredentials: boolean
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: AuthSessionWirePayload = {
    u: username,
    iat: now,
    exp: now + AUTH_SESSION_TTL_SECONDS,
    ...(mustChangeCredentials ? { mcc: 1 } : {}),
  };

  const payloadB64 = encodeBase64Url(utf8ToBytes(JSON.stringify(payload)));
  const sigB64 = await signPayload(payloadB64);
  return `${payloadB64}.${sigB64}`;
}

export async function verifySessionToken(
  token: string
): Promise<AuthSessionPayload | null> {
  const [payloadB64, signatureB64] = token.split(".", 2);
  if (!payloadB64 || !signatureB64) {
    return null;
  }

  const expectedSignature = await signPayload(payloadB64);
  if (!safeEqual(signatureB64, expectedSignature)) {
    return null;
  }

  const payloadBytes = decodeBase64Url(payloadB64);
  if (!payloadBytes) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytesToUtf8(payloadBytes));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const wire = parsed as Partial<AuthSessionWirePayload>;
  if (
    typeof wire.u !== "string" ||
    !wire.u.trim() ||
    typeof wire.iat !== "number" ||
    typeof wire.exp !== "number"
  ) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (wire.exp <= now) {
    return null;
  }

  return {
    username: wire.u,
    issuedAt: wire.iat,
    expiresAt: wire.exp,
    mustChangeCredentials: wire.mcc === 1,
  };
}

export function getSessionCookieOptions() {
  return getSessionCookieOptionsForRequest(false);
}

export function isRequestSecure(url: string, headers: Headers): boolean {
  const forwardedProto = headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto) {
    return forwardedProto === "https";
  }

  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function getSessionCookieOptionsForRequest(requestSecure: boolean) {
  const secureOverride = parseBooleanEnv(process.env.EGGENT_AUTH_COOKIE_SECURE);
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: secureOverride ?? requestSecure,
    path: "/",
    maxAge: AUTH_SESSION_TTL_SECONDS,
  };
}

export function getClearedSessionCookieOptions(requestSecure = false) {
  return {
    ...getSessionCookieOptionsForRequest(requestSecure),
    maxAge: 0,
  };
}
