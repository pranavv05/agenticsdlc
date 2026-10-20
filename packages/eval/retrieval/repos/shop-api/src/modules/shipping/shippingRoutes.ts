import { router } from "../../http/router";
import { findOrder } from "../orders/orderRepo";
import type { Address } from "./address";
import { createShipment, trackShipment } from "./shippingService";

router.post("/shipments", (req) => {
  const body = req.body as { orderId: string; address: Address };
  const order = findOrder(body.orderId);
  if (!order) throw new Error(`Order ${body.orderId} not found`);
  return createShipment(order, body.address);
});

router.get("/shipments/:id", (req) => trackShipment(req.params.id));
