import { getSession } from "../auth/session";

export function requireBillingAccess(token: string): string {
  const session = getSession(token);
  if (!session) throw new Error("Not authenticated: billing requires a valid session");
  return session.userId;
}
