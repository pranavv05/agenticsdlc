import { orderTotalCents, type Order } from "../orders/order";
import type { Payment } from "./paymentService";

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Plain-text receipt for a paid order. */
export function buildReceipt(order: Order, payment: Payment): string {
  const lines = order.items.map((i) => `${i.quantity} x ${i.sku}  ${dollars(i.unitPriceCents * i.quantity)}`);
  return [`Receipt for order ${order.id}`, ...lines, `Total ${dollars(orderTotalCents(order))}`, `Payment ${payment.id}`].join("\n");
}
