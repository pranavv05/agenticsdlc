import { router } from "../../http/router";
import type { OrderItem } from "./order";
import { findOrder, listOrdersByCustomer } from "./orderRepo";
import { cancelOrder, placeOrder } from "./orderService";

router.post("/orders", (req) => {
  const body = req.body as { items: OrderItem[]; cardToken: string };
  return placeOrder(req.userId ?? "anonymous", body.items, body.cardToken);
});

router.get("/orders/:id", (req) => findOrder(req.params.id));

router.get("/customers/:id/orders", (req) => listOrdersByCustomer(req.params.id));

router.post("/orders/:id/cancel", (req) => cancelOrder(req.params.id));
