import { cookies } from "next/headers";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { getUserByUsername, type User } from "@/lib/storage/users-store";

/**
 * Extract the current authenticated user from the session cookie.
 * Returns null if no valid session or user not found.
 * Intended for use inside API routes / server components.
 */
export async function getCurrentUser(): Promise<User | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await verifySessionToken(token);
  if (!session) return null;

  return getUserByUsername(session.username);
}
