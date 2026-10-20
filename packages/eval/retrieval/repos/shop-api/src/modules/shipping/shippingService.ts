import type { Order } from "../orders/order";
import { findOrder, saveOrder } from "../orders/orderRepo";
import { assertTransition } from "../orders/orderStatus";
import type { Address } from "./address";
import { cheapestRate, quoteRates, type RateQuote } from "./carriers";

export interface Shipment {
  id: string;
  orderId: string;
  address: Address;
  carrier: RateQuote["carrier"];
  trackingNumber: string;
  delivered: boolean;
}

const shipments = new Map<string, Shipment>();

export function createShipment(order: Order, address: Address): Shipment {
  const rate = cheapestRate(quoteRates({ weightGrams: order.items.length * 400 }, address));
  const shipment: Shipment = {
    id: `shp_${Date.now()}`,
    orderId: order.id,
    address,
    carrier: rate.carrier,
    trackingNumber: `TRK${Math.floor(Math.random() * 1e9)}`,
    delivered: false,
  };
  shipments.set(shipment.id, shipment);
  assertTransition(order.status, "shipped");
  saveOrder({ ...order, status: "shipped", shipmentId: shipment.id });
  return shipment;
}

export function trackShipment(id: string): Shipment | undefined {
  return shipments.get(id);
}

export function markDelivered(id: string): void {
  const shipment = shipments.get(id);
  if (!shipment) throw new Error(`Shipment ${id} not found`);
  shipment.delivered = true;
  const order = findOrder(shipment.orderId);
  if (order) saveOrder({ ...order, status: "delivered" });
}
