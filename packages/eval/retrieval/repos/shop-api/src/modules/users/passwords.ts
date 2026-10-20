import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(plain, salt, 64).toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  const candidate = scryptSync(plain, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}
