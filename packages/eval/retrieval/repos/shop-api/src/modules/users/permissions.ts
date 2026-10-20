export type Role = "customer" | "staff" | "admin";
export type Action = "orders:read-all" | "orders:cancel" | "inventory:adjust" | "users:manage";

const GRANTS: Record<Role, Action[]> = {
  customer: [],
  staff: ["orders:read-all", "orders:cancel", "inventory:adjust"],
  admin: ["orders:read-all", "orders:cancel", "inventory:adjust", "users:manage"],
};

export function can(role: Role, action: Action): boolean {
  return GRANTS[role].includes(action);
}
