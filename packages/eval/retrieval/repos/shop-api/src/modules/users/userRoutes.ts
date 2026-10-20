import { router } from "../../http/router";
import { login, registerUser } from "./userService";

router.post("/register", (req) => {
  const body = req.body as { email: string; password: string };
  return registerUser(body.email, body.password);
});

router.post("/login", (req) => {
  const body = req.body as { email: string; password: string };
  return { token: login(body.email, body.password) };
});
