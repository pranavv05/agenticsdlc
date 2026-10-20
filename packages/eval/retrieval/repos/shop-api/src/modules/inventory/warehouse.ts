export interface Warehouse {
  id: string;
  city: string;
  stock: Map<string, number>;
}

export const warehouses: Warehouse[] = [
  { id: "wh-east", city: "Newark", stock: new Map() },
  { id: "wh-west", city: "Reno", stock: new Map() },
];

/** Picks the warehouse holding the most units of a SKU that can cover the quantity. */
export function pickWarehouse(sku: string, quantity: number): Warehouse | undefined {
  return warehouses.filter((w) => (w.stock.get(sku) ?? 0) >= quantity).sort((a, b) => (b.stock.get(sku) ?? 0) - (a.stock.get(sku) ?? 0))[0];
}
