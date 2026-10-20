const SECRET = "fixture-secret";

export function issueToken(userId: string, ttlSeconds = 3600): string {
  const expires = Date.now() + ttlSeconds * 1000;
  return Buffer.from(`${userId}:${expires}:${SECRET}`).toString("base64");
}

export function verifyToken(token: string): { userId: string } | null {
  const [userId, expires, secret] = Buffer.from(token, "base64").toString().split(":");
  if (secret !== SECRET || Number(expires) < Date.now()) return null;
  return { userId };
}
