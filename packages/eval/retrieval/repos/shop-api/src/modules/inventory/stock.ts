import { isValidSku } from "./sku";
import { pickWarehouse, warehouses } from "./warehouse";

/** Units available across every warehouse. */
export function getStock(sku: string): number {
  return warehouses.reduce((sum, w) => sum + (w.stock.get(sku) ?? 0), 0);
}

export function adjustStock(sku: string, warehouseId: string, delta: number): void {
  const warehouse = warehouses.find((w) => w.id === warehouseId);
  if (!warehouse) throw new Error(`Unknown warehouse ${warehouseId}`);
  warehouse.stock.set(sku, Math.max(0, (warehouse.stock.get(sku) ?? 0) + delta));
}

/** Takes units out of a warehouse for an order. */
export function reserveStock(sku: string, quantity: number): void {
  if (!isValidSku(sku)) throw new Error(`Unknown SKU ${sku}`);
  const warehouse = pickWarehouse(sku, quantity);
  if (!warehouse) throw new Error(`Not enough stock of ${sku}`);
  adjustStock(sku, warehouse.id, -quantity);
}

export function releaseStock(sku: string, quantity: number): void {
  adjustStock(sku, warehouses[0].id, quantity);
}
