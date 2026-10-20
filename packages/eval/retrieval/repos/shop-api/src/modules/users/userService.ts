import { hashPassword, verifyPassword } from "./passwords";
import type { Role } from "./permissions";
import { issueSession } from "./sessions";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
}

const users = new Map<string, User>();

export function registerUser(email: string, password: string, role: Role = "customer"): User {
  if (users.has(email)) throw new Error("Email already registered");
  const user: User = { id: `usr_${users.size + 1}`, email, passwordHash: hashPassword(password), role };
  users.set(email, user);
  return user;
}

/** Checks the password and returns a session token. */
export function login(email: string, password: string): string {
  const user = users.get(email);
  if (!user || !verifyPassword(password, user.passwordHash)) throw new Error("Wrong email or password");
  return issueSession(user.id);
}

export function changePassword(email: string, oldPassword: string, newPassword: string): void {
  const user = users.get(email);
  if (!user || !verifyPassword(oldPassword, user.passwordHash)) throw new Error("Wrong email or password");
  user.passwordHash = hashPassword(newPassword);
}
