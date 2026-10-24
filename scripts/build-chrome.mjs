import { build } from "esbuild";
import { mkdir, copyFile, rm } from "node:fs/promises";
await rm("dist-chrome", { recursive: true, force: true });
await mkdir("dist-chrome");
for (const file of ["manifest.json", "background.js", "app.html", "app.css"])
  await copyFile(`chrome/${file}`, `dist-chrome/${file}`);
await build({
  entryPoints: ["chrome/app.mjs", "chrome/worker.ts"],
  outdir: "dist-chrome",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  minify: false,
  legalComments: "inline",
});
