// tsc emits only .ts sources; copy the vendored .mjs core next to the compiled output.
// Usage: node scripts/copy-vendor.mjs <compiled src root>, e.g. dist or dist-tests/src
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[2];
if (!target || !existsSync(target)) {
  console.error(`copy-vendor: compiled output directory not found: ${target}`);
  process.exit(1);
}
cpSync("src/vendor", join(target, "vendor"), {
  recursive: true,
  filter: (source) => !source.endsWith(".d.mts"),
});
