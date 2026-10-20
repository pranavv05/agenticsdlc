import { router } from "../../http/router";
import { adjustStock, getStock } from "./stock";

router.get("/inventory/:sku", (req) => ({ sku: req.params.sku, available: getStock(req.params.sku) }));

router.post("/inventory/adjust", (req) => {
  const body = req.body as { sku: string; warehouseId: string; delta: number };
  adjustStock(body.sku, body.warehouseId, body.delta);
  return { ok: true };
});
