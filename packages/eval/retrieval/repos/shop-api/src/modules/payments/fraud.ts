import { orderTotalCents, type Order } from "../orders/order";

export interface FraudVerdict {
  blocked: boolean;
  reason?: string;
}

const MAX_SINGLE_ORDER_CENTS = 500_000;
const recentOrders = new Map<string, number[]>();

/** Rule-based screening that runs before a card is charged. */
export function checkFraud(order: Order): FraudVerdict {
  if (orderTotalCents(order) > MAX_SINGLE_ORDER_CENTS) return { blocked: true, reason: "order value above the review limit" };

  const now = Date.now();
  const lastHour = (recentOrders.get(order.customerId) ?? []).filter((t) => now - t < 3_600_000);
  if (lastHour.length >= 5) return { blocked: true, reason: "too many orders in the last hour" };
  recentOrders.set(order.customerId, [...lastHour, now]);
  return { blocked: false };
}
