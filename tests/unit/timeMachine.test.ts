import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { TimeMachine } from "../../src/ui/timeMachine";

describe("TimeMachine (Deterministic Snapshot & Atomic Transactions)", () => {
  test("должен создавать неизменяемый снапшот с детерминированным SHA-256 хешем", () => {
    const tm = new TimeMachine();
    const snap1 = tm.createSnapshot(
      "Добавь логирование",
      [{ filePath: "src/app.ts", content: "const a = 1;" }],
      1700000000000
    );
    const snap2 = tm.createSnapshot(
      "Добавь логирование",
      [{ filePath: "src/app.ts", content: "const a = 1;" }],
      1700000000000
    );

    assert.equal(snap1.id, snap2.id);
    assert.equal(snap1.snapshotHash, snap2.snapshotHash);
    assert.equal(snap1.files[0].sha256.length, 64);
    assert.equal(tm.verifySnapshotIntegrity(snap1), true);
  });

  test("rollbackLast должен возвращать последнее состояние в порядке LIFO", () => {
    const tm = new TimeMachine();
    tm.createSnapshot("Vibe 1", [{ filePath: "a.ts", content: "v1" }], 100);
    tm.createSnapshot("Vibe 2", [{ filePath: "a.ts", content: "v2" }], 200);

    const last = tm.rollbackLast();
    assert.ok(last);
    assert.equal(last.intent, "Vibe 2");
    assert.equal(last.files[0].content, "v2");

    const first = tm.rollbackLast();
    assert.ok(first);
    assert.equal(first.intent, "Vibe 1");
    assert.equal(first.files[0].content, "v1");

    assert.equal(tm.rollbackLast(), null);
  });

  test("rollbackTo должен откатывать к выбранному ID и отсекать более поздние изменения", () => {
    const tm = new TimeMachine();
    const s1 = tm.createSnapshot("Step 1", [{ filePath: "a.ts", content: "1" }], 100);
    const s2 = tm.createSnapshot("Step 2", [{ filePath: "a.ts", content: "2" }], 200);
    tm.createSnapshot("Step 3", [{ filePath: "a.ts", content: "3" }], 300);

    const restored = tm.rollbackTo(s2.id);
    assert.equal(restored.id, s2.id);
    assert.equal(restored.files[0].content, "2");

    const remaining = tm.getHistory();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, s1.id);
  });

  test("applyTransaction должен атомарно применять патчи и откатывать снапшот при ошибке", () => {
    const tm = new TimeMachine();
    const files = [{ filePath: "service.ts", content: "const mode = 'dev';" }];

    // Успешная транзакция
    const tx = tm.applyTransaction(
      "Switch to prod",
      files,
      [{ targetFile: "service.ts", searchBlock: "'dev'", replaceBlock: "'prod'", explanation: "prod" }],
      500
    );
    assert.equal(tx.updatedFiles.get("service.ts"), "const mode = 'prod';");
    assert.equal(tm.getHistory().length, 1);

    // Сбойная транзакция (несуществующий блок во втором патче) не должна засорять историю
    assert.throws(() => {
      tm.applyTransaction(
        "Broken multi-patch",
        files,
        [
          { targetFile: "service.ts", searchBlock: "'dev'", replaceBlock: "'stage'", explanation: "ok" },
          { targetFile: "service.ts", searchBlock: "MISSING", replaceBlock: "fail", explanation: "fail" },
        ],
        600
      );
    }, /TransactionError/);

    // В истории должна остаться только первая успешная транзакция
    assert.equal(tm.getHistory().length, 1);
  });

  test("должен соблюдать лимит maxHistorySize и вытеснять самые старые снапшоты", () => {
    const tm = new TimeMachine(2);
    tm.createSnapshot("Oldest", [{ filePath: "a.ts", content: "1" }], 100);
    tm.createSnapshot("Middle", [{ filePath: "a.ts", content: "2" }], 200);
    tm.createSnapshot("Newest", [{ filePath: "a.ts", content: "3" }], 300);

    const history = tm.getHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].intent, "Newest");
    assert.equal(history[1].intent, "Middle");
  });
});
