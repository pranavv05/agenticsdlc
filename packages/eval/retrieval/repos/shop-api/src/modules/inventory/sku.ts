const SKU_PATTERN = /^[A-Z]{3}-\d{4}-[A-Z0-9]{2}$/;

export function isValidSku(sku: string): boolean {
  return SKU_PATTERN.test(sku);
}

/** Splits a SKU such as "TEE-0042-BL" into its product family, number and variant. */
export function parseSku(sku: string): { family: string; number: number; variant: string } {
  if (!isValidSku(sku)) throw new Error(`Not a valid SKU: ${sku}`);
  const [family, number, variant] = sku.split("-");
  return { family, number: Number(number), variant };
}
