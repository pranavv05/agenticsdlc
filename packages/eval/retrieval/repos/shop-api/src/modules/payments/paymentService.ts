import { orderTotalCents, type Order } from "../orders/order";
import { createCharge, createRefund } from "./gateway";

export interface Payment {
  id: string;
  orderId: string;
  amountCents: number;
  refundedCents: number;
}

const payments = new Map<string, Payment>();

export async function chargeOrder(order: Order, cardToken: string): Promise<Payment> {
  const amountCents = orderTotalCents(order);
  const charge = await createCharge(cardToken, amountCents);
  if (charge.status !== "succeeded") throw new Error("The card was declined");
  const payment: Payment = { id: charge.id, orderId: order.id, amountCents, refundedCents: 0 };
  payments.set(payment.id, payment);
  return payment;
}

/** Returns money to the customer's card. A partial amount is allowed; the total refunded can never exceed what was charged. */
export async function refundPayment(paymentId: string, amountCents: number): Promise<Payment> {
  const payment = payments.get(paymentId);
  if (!payment) throw new Error(`Payment ${paymentId} not found`);
  if (payment.refundedCents + amountCents > payment.amountCents) throw new Error("Cannot refund more than was charged");
  await createRefund(paymentId, amountCents);
  payment.refundedCents += amountCents;
  return payment;
}

export function findPayment(paymentId: string): Payment | undefined {
  return payments.get(paymentId);
}
