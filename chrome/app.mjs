import {
  makeDocument,
  decodeUtf8,
  encodeUtf8,
  DOCUMENT_LIMITS,
} from "../src/vendor/deterministic-extensions/documents.mjs";
import {
  createSession,
  reduceSession,
} from "../src/vendor/deterministic-extensions/session.mjs";
import { createResultGate } from "../src/vendor/deterministic-extensions/gates.mjs";
import { CHECK_POLICY } from "../src/check/proposal";
import { validateDrydockReport } from "../src/check/drydock.mjs";
const $ = (id) => document.getElementById(id);
let session = createSession(),
  serial = 0,
  generation = 0,
  pending = null,
  worker = null;
let gate = createResultGate();
const context = () =>
  JSON.stringify([
    $("filename").value,
    $("format").value,
    $("answer").value,
    CHECK_POLICY,
    "babel-8.0.7",
  ]);
function invalidate() {
  generation++;
  gate.invalidate();
  worker?.terminate();
  worker = null;
  pending = null;
  $("candidate").disabled = true;
  $("accept").disabled = true;
  $("attention").checked = false;
  $("attention-label").hidden = true;
  $("diff").textContent = "";
  $("report-details").textContent = "";
  $("report-status").textContent =
    "Отчёт не загружен. Проверка Drydock не выполнялась.";
}
function render() {
  $("source").textContent = session.b.raw;
  $("undo").disabled = !session.past.length;
  $("redo").disabled = !session.future.length;
}
function load(doc, name) {
  invalidate();
  session = createSession({ a: doc, b: doc });
  gate = createResultGate();
  $("filename").value = name;
  render();
  $("status").textContent = "Файл открыт. Вставьте предложение.";
}
function command(type, document) {
  const result = reduceSession(session, {
    type,
    id: `ui-${++serial}`,
    expectedRevision: session.revision,
    ...(document ? { document } : {}),
  });
  if (result.status !== "applied") throw Error(result.status);
  session = result.state;
  invalidate();
  render();
}
$("example").onclick = () => {
  load(
    makeDocument(
      'export function greet(name: string): string {\r\n  return "Hello, " + name;\r\n}\r\n',
      true,
    ),
    "greet.ts",
  );
  $("answer").value = JSON.stringify(
    {
      intentSummary: "Приветствие по-русски",
      patches: [
        {
          targetFile: "greet.ts",
          searchBlock: '"Hello, "',
          replaceBlock: '"Привет, "',
          explanation: "Изменение приветствия",
        },
      ],
    },
    null,
    2,
  );
  $("format").value = "sr";
};
$("file").onchange = async () => {
  invalidate();
  const epoch = generation,
    file = $("file").files[0];
  if (!file) return;
  try {
    if (file.size > DOCUMENT_LIMITS.maxBytes)
      throw Error("Файл превышает 1 MiB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (epoch !== generation) return;
    load(decodeUtf8(bytes), file.name);
  } catch (e) {
    if (epoch === generation) $("status").textContent = String(e);
  } finally {
    $("file").value = "";
  }
};
for (const id of ["filename", "format", "answer"])
  $(id).addEventListener("input", () => {
    invalidate();
    $("status").textContent = "Входные данные изменены. Повторите проверку.";
  });
$("cancel").onclick = () => {
  invalidate();
  $("status").textContent = "Проверка отменена.";
};
$("check").onclick = () => {
  invalidate();
  const captured = context(),
    revision = session.revision,
    ticket = gate.issue(revision, captured);
  $("status").textContent = "Проверяем…";
  worker = new Worker("worker.js", { type: "module" });
  worker.onerror = () => {
    invalidate();
    $("status").textContent = "Проверка недоступна: ошибка worker.";
  };
  worker.onmessage = ({ data }) => {
    if (!gate.accept(data.ticket, session.revision, context())) return;
    worker?.terminate();
    worker = null;
    const r = data.result;
    if (r.stage !== "ok" || typeof r.result !== "string" || !r.diff) {
      $("status").textContent = `${r.stage}: ${r.error || "Неполная проверка"}`;
      return;
    }
    let doc;
    try {
      doc = makeDocument(r.result, session.b.bom);
    } catch (e) {
      $("status").textContent = String(e);
      return;
    }
    pending = { revision, context: captured, document: doc };
    $("candidate").disabled = false;
    $("status").textContent = [
      r.semantic?.formattedSummary || "",
      ...r.attention,
    ].join("\n");
    $("diff").textContent = r.diff.rows
      .map(
        (row) =>
          (row.kind === "added" ? "+ " : row.kind === "removed" ? "- " : "  ") +
          row.text,
      )
      .join("\n");
    $("attention-label").hidden = !r.attention.length;
    $("accept").disabled = !!r.attention.length;
  };
  worker.postMessage({
    ticket,
    input: {
      source: session.b.raw,
      answer: $("answer").value,
      fileName: $("filename").value,
      format: $("format").value,
    },
  });
};
$("attention").onchange = () => {
  $("accept").disabled = !pending || !$("attention").checked;
};
$("accept").onclick = () => {
  if (
    !pending ||
    pending.revision !== session.revision ||
    pending.context !== context() ||
    (!$("attention-label").hidden && !$("attention").checked)
  )
    return;
  try {
    command("replace-b", pending.document);
    $("status").textContent =
      "Изменение принято. Можно отменить или скачать файл.";
  } catch (e) {
    $("status").textContent = String(e);
  }
};
for (const type of ["undo", "redo"])
  $(type).onclick = () => {
    try {
      command(type);
      $("status").textContent =
        type === "undo" ? "Изменение отменено." : "Изменение восстановлено.";
    } catch (e) {
      $("status").textContent = String(e);
    }
  };
function download(doc) {
  const url = URL.createObjectURL(new Blob([encodeUtf8(doc)]));
  const a = document.createElement("a");
  a.href = url;
  a.download = $("filename").value.split(/[\\/]/).pop() || "result.ts";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("download").onclick = () => download(session.b);
$("candidate").onclick = () => {
  if (pending) download(pending.document);
};
$("report").onchange = async () => {
  const epoch = generation,
    file = $("report").files[0],
    candidate = pending?.document;
  if (!file) return;
  try {
    if (!candidate) throw Error("Сначала проверьте предложение");
    if (file.size > 2_000_000) throw Error("Отчёт слишком большой");
    const raw = JSON.parse(await file.text());
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", encodeUtf8(candidate)),
      ),
      (x) => x.toString(16).padStart(2, "0"),
    ).join("");
    if (epoch !== generation) return;
    const report = validateDrydockReport(raw, hash, $("filename").value);
    $("report-details").textContent = JSON.stringify(report, null, 2);
    $("report-status").textContent =
      `Drydock: ${report.status}. Находок: ${report.findings.length}. Ограничения: ${report.limitations.join("; ")}. Импортированный отчёт не является подписанной аттестацией.`;
  } catch (e) {
    if (epoch === generation)
      $("report-status").textContent = `Отчёт отклонён: ${e}`;
  } finally {
    $("report").value = "";
  }
};
render();
