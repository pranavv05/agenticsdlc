const BASE_URL = "https://api.paymentprovider.example/v1";

export interface GatewayCharge {
  id: string;
  amountCents: number;
  status: "succeeded" | "failed";
}

/** Thin client for the external card processor. */
export async function createCharge(cardToken: string, amountCents: number): Promise<GatewayCharge> {
  const res = await fetch(`${BASE_URL}/charges`, { method: "POST", body: JSON.stringify({ source: cardToken, amount: amountCents }) });
  if (!res.ok) throw new Error(`Card processor error ${res.status}`);
  return (await res.json()) as GatewayCharge;
}

export async function createRefund(chargeId: string, amountCents: number): Promise<{ id: string; amountCents: number }> {
  const res = await fetch(`${BASE_URL}/refunds`, { method: "POST", body: JSON.stringify({ charge: chargeId, amount: amountCents }) });
  if (!res.ok) throw new Error(`Card processor refused the refund: ${res.status}`);
  return (await res.json()) as { id: string; amountCents: number };
}
