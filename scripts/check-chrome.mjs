import { chromium } from "playwright";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  assert.equal(await page.isVisible("#attention-label"), false);
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
  const candidateDownload = page.waitForEvent("download");
  await page.click("#candidate");
  const candidateBytes = await readFile(await (await candidateDownload).path());
  const evidence = {
    schema: "vibe-drydock-evidence-v1",
    file: "greet.ts",
    candidate_sha256: createHash("sha256").update(candidateBytes).digest("hex"),
    source_snapshot_sha256: "b".repeat(64),
    catalog_sha256: "c".repeat(64),
    engine_version: "test-fixture",
    runtime_verified: false,
    status: "unknown",
    findings: [{ status: "unknown", title: "Unresolved applicability" }],
    limitations: ["single_file_only"],
  };
  const importEvidence = async (value) =>
    page.setInputFiles("#report", {
      name: "evidence.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(value)),
    });
  await importEvidence(evidence);
  await page.waitForFunction(() =>
    document
      .querySelector("#report-status")
      .textContent.includes("Drydock: unknown"),
  );
  assert.match(
    await page.textContent("#report-details"),
    /Unresolved applicability/,
  );
  await importEvidence({ ...evidence, candidate_sha256: "d".repeat(64) });
  await page.waitForFunction(() =>
    document.querySelector("#report-status").textContent.includes("отклонён"),
  );
  await page.fill(
    "#answer",
    JSON.stringify({
      intentSummary: "Remove greet",
      patches: [
        {
          targetFile: "greet.ts",
          searchBlock:
            'export function greet(name: string): string {\r\n  return "Hello, " + name;\r\n}\r\n',
          replaceBlock: 'export const greeting = "hello";\r\n',
          explanation: "replacement",
        },
      ],
    }),
  );
  await page.click("#check");
  await page.waitForFunction(
    () => !document.querySelector("#attention-label").hidden,
  );
  assert.equal(await page.isDisabled("#accept"), true);
  await page.check("#attention");
  assert.equal(await page.isDisabled("#accept"), false);
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
