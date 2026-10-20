import { issueToken, verifyToken } from "./tokens";

const sessions = new Map<string, string>();

export function createSession(userId: string): string {
  const token = issueToken(userId);
  sessions.set(token, userId);
  return token;
}

export function getSession(token: string): { userId: string } | null {
  return sessions.has(token) ? verifyToken(token) : null;
}
