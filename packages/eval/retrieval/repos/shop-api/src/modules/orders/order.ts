export type OrderStatus = "pending" | "paid" | "shipped" | "delivered" | "cancelled";

export interface OrderItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  customerId: string;
  items: OrderItem[];
  status: OrderStatus;
  paymentId?: string;
  shipmentId?: string;
  createdAt: number;
}

export function orderTotalCents(order: Order): number {
  return order.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
}

export function createOrderRecord(customerId: string, items: OrderItem[]): Order {
  return { id: `ord_${Date.now()}`, customerId, items, status: "pending", createdAt: Date.now() };
}
