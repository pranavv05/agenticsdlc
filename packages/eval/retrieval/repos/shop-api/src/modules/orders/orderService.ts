import { releaseStock, reserveStock } from "../inventory/stock";
import { checkFraud } from "../payments/fraud";
import { chargeOrder, refundPayment } from "../payments/paymentService";
import { createOrderRecord, orderTotalCents, type Order, type OrderItem } from "./order";
import { findOrder, saveOrder } from "./orderRepo";
import { assertTransition } from "./orderStatus";

export async function placeOrder(customerId: string, items: OrderItem[], cardToken: string): Promise<Order> {
  const order = createOrderRecord(customerId, items);
  for (const item of items) reserveStock(item.sku, item.quantity);
  const verdict = checkFraud(order);
  if (verdict.blocked) {
    for (const item of items) releaseStock(item.sku, item.quantity);
    throw new Error(`Order rejected: ${verdict.reason}`);
  }
  const payment = await chargeOrder(order, cardToken);
  assertTransition(order.status, "paid");
  return saveOrder({ ...order, status: "paid", paymentId: payment.id });
}

/** Cancels an order that has not shipped: puts the stock back and returns the customer's money. */
export async function cancelOrder(orderId: string): Promise<Order> {
  const order = findOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  assertTransition(order.status, "cancelled");
  for (const item of order.items) releaseStock(item.sku, item.quantity);
  if (order.paymentId) await refundPayment(order.paymentId, orderTotalCents(order));
  return saveOrder({ ...order, status: "cancelled" });
}
