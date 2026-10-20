import fs from "node:fs";
import path from "node:path";
import { renderApiDocs } from "../src/api-docs";

const target = path.resolve(import.meta.dirname, "../../../docs/API.md");
const rendered = renderApiDocs();

if (process.argv.includes("--check")) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== rendered) {
    console.error("docs/API.md is out of date with the schemas in packages/contracts. Run `pnpm docs:api` and commit the result.");
    process.exit(1);
  }
  console.log("docs/API.md is up to date.");
} else {
  fs.writeFileSync(target, rendered);
  console.log("Wrote docs/API.md");
}
