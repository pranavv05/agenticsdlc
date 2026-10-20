import { getStock } from "./stock";

const REORDER_LEVEL = 20;
const REORDER_QUANTITY = 100;

export interface PurchaseOrder {
  sku: string;
  quantity: number;
  requestedAt: number;
}

export function needsRestock(sku: string): boolean {
  return getStock(sku) <= REORDER_LEVEL;
}

/** Asks the supplier for more units of a SKU that is running low. */
export function createPurchaseOrder(sku: string): PurchaseOrder | null {
  if (!needsRestock(sku)) return null;
  return { sku, quantity: REORDER_QUANTITY, requestedAt: Date.now() };
}
