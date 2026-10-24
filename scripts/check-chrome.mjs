import { chromium } from "playwright";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const profile = await mkdtemp(join(tmpdir(), "vibe-browser-"));
const extension = resolve("dist-chrome");
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
  viewport: { width: 1280, height: 1000 },
  acceptDownloads: true,
});
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.click("#example");
  await page.click("#check");
  await page.waitForFunction(() => !document.querySelector("#accept").disabled);
  assert.match(await page.textContent("#diff"), /Привет/);
  assert.match(await page.textContent("#source"), /Hello/);
  await page.click("#accept");
  assert.match(await page.textContent("#source"), /Привет/);
  await page.click("#undo");
  assert.match(await page.textContent("#source"), /Hello/);
  await page.click("#redo");
  assert.match(await page.textContent("#source"), /Привет/);
  const downloadPromise = page.waitForEvent("download");
  await page.click("#download");
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());
  assert.equal(bytes.toString("hex").slice(0, 6), "efbbbf");
  assert.ok(bytes.toString("utf8").includes("\r\n"));
  assert.ok(!bytes.toString("utf8").replaceAll("\r\n", "").includes("\n"));
  // Input edits invalidate both checked proposals and in-flight worker responses.
  await page.click("#undo");
  await page.click("#check");
  await page.fill("#answer", "invalid");
  await page.waitForTimeout(300);
  assert.equal(await page.isDisabled("#accept"), true);
  await page.click("#example");
  await page.click("#check");
  await page.waitForFunction(() => !document.querySelector("#accept").disabled);
  await page.fill("#filename", "different.ts");
  assert.equal(await page.isDisabled("#accept"), true);
  await page.click("#example");
  await page.click("#check");
  await page.click("#cancel");
  await page.waitForTimeout(300);
  assert.equal(await page.isDisabled("#accept"), true);
  await page.setInputFiles("#file", {
    name: "bad.ts",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0xff]),
  });
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("UTF-8"),
  );
  await page.click("#example");
  await page.click("#check");
  await page.waitForFunction(() => !document.querySelector("#accept").disabled);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/chrome-preview.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Installed MV3: preview, explicit accept, Undo/Redo, BOM/CRLF download, stale/cancel and invalid UTF-8 passed.",
  );
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
