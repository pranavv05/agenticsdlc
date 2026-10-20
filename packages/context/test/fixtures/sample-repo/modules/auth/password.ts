import { createHash } from "node:crypto";

export function hashPassword(plain: string, salt: string): string {
  return createHash("sha256").update(salt + plain).digest("hex");
}

export function checkPassword(plain: string, salt: string, hash: string): boolean {
  return hashPassword(plain, salt) === hash;
}
