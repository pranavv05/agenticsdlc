import type { Shipment } from "./shippingService";

/** Builds the ZPL text a thermal label printer understands. */
export function buildLabel(shipment: Shipment): string {
  const a = shipment.address;
  return [
    "^XA",
    `^FO50,50^A0N,40,40^FD${a.name}^FS`,
    `^FO50,100^FD${a.line1}, ${a.city} ${a.postalCode}^FS`,
    `^FO50,160^BCN,80^FD${shipment.trackingNumber}^FS`,
    "^XZ",
  ].join("\n");
}
