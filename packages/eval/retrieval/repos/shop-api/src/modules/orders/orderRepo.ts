import type { Order, OrderStatus } from "./order";

const orders = new Map<string, Order>();

export function saveOrder(order: Order): Order {
  orders.set(order.id, order);
  return order;
}

export function findOrder(id: string): Order | undefined {
  return orders.get(id);
}

export function listOrdersByCustomer(customerId: string): Order[] {
  return [...orders.values()].filter((o) => o.customerId === customerId);
}

export function listOrdersByStatus(status: OrderStatus): Order[] {
  return [...orders.values()].filter((o) => o.status === status);
}
