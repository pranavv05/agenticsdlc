import { router } from "../../http/router";
import { findPayment, refundPayment } from "./paymentService";

router.get("/payments/:id", (req) => findPayment(req.params.id));

router.post("/payments/:id/refund", (req) => {
  const body = req.body as { amountCents: number };
  return refundPayment(req.params.id, body.amountCents);
});
