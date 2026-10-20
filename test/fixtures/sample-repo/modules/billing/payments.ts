import { Invoice, calculateInvoiceTotal } from "./invoice";

export function chargeCard(invoice: Invoice, cardToken: string): Invoice {
  const due = calculateInvoiceTotal(invoice) - invoice.paidCents;
  if (due <= 0) throw new Error("Invoice already paid");
  console.log(`charging card ${cardToken} for ${due} cents`);
  return { ...invoice, paidCents: invoice.paidCents + due };
}

export function refundPayment(invoice: Invoice, amountCents: number): Invoice {
  if (amountCents > invoice.paidCents) throw new Error("Cannot refund more than was paid");
  return { ...invoice, paidCents: invoice.paidCents - amountCents };
}

const router = { post: (_path: string, _handler: unknown) => {} };

router.post("/billing/charge", (req: { invoice: Invoice; cardToken: string }) => chargeCard(req.invoice, req.cardToken));
