export interface LineItem {
  description: string;
  unitPriceCents: number;
  quantity: number;
}

export interface Invoice {
  id: string;
  customerId: string;
  items: LineItem[];
  paidCents: number;
}

export function calculateInvoiceTotal(invoice: Invoice): number {
  return invoice.items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
}

export function createInvoice(customerId: string, items: LineItem[]): Invoice {
  return { id: `inv_${Date.now()}`, customerId, items, paidCents: 0 };
}
