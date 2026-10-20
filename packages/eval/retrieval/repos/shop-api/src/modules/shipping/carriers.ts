import type { Address } from "./address";

export interface Parcel {
  weightGrams: number;
}

export interface RateQuote {
  carrier: "swiftpost" | "northwind" | "parcelhub";
  priceCents: number;
  days: number;
}

/** Prices a parcel with every carrier we ship with. */
export function quoteRates(parcel: Parcel, to: Address): RateQuote[] {
  const kg = Math.ceil(parcel.weightGrams / 1000);
  const abroad = to.country !== "US" ? 1500 : 0;
  return [
    { carrier: "swiftpost", priceCents: 700 + kg * 250 + abroad, days: 2 },
    { carrier: "northwind", priceCents: 450 + kg * 300 + abroad, days: 5 },
    { carrier: "parcelhub", priceCents: 550 + kg * 200 + abroad, days: 4 },
  ];
}

export function cheapestRate(quotes: RateQuote[]): RateQuote {
  return quotes.reduce((best, q) => (q.priceCents < best.priceCents ? q : best));
}
