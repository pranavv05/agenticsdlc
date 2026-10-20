export interface Address {
  name: string;
  line1: string;
  city: string;
  postalCode: string;
  country: "US" | "CA" | "GB";
}

const POSTAL_PATTERNS: Record<Address["country"], RegExp> = {
  US: /^\d{5}(-\d{4})?$/,
  CA: /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/,
  GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/,
};

/** Returns the problems with an address, or an empty list when it can be shipped to. */
export function validateAddress(address: Address): string[] {
  const problems: string[] = [];
  if (!address.name.trim()) problems.push("recipient name is missing");
  if (!address.line1.trim()) problems.push("street line is missing");
  if (!POSTAL_PATTERNS[address.country].test(address.postalCode.toUpperCase()))
    problems.push(`postal code ${address.postalCode} is not valid for ${address.country}`);
  return problems;
}

export function normalizeAddress(address: Address): Address {
  return { ...address, name: address.name.trim(), line1: address.line1.trim(), postalCode: address.postalCode.toUpperCase().trim() };
}
