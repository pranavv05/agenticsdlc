import { createHmac, randomBytes } from "node:crypto";

const SECRET = process.env.SESSION_SECRET ?? "dev-secret";
const revoked = new Set<string>();

/** Signed session token: userId, expiry, random id, and an HMAC over them. */
export function issueSession(userId: string, ttlSeconds = 3600): string {
  const payload = `${userId}.${Date.now() + ttlSeconds * 1000}.${randomBytes(6).toString("hex")}`;
  const signature = createHmac("sha256", SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}.${signature}`).toString("base64url");
}

export function verifySession(token: string): { userId: string } | null {
  if (revoked.has(token)) return null;
  const parts = Buffer.from(token, "base64url").toString().split(".");
  const signature = parts.pop();
  const payload = parts.join(".");
  if (signature !== createHmac("sha256", SECRET).update(payload).digest("hex")) return null;
  if (Number(parts[1]) < Date.now()) return null;
  return { userId: parts[0] };
}

export function revokeSession(token: string): void {
  revoked.add(token);
}
