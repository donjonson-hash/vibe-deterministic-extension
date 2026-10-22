import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { DeterministicLogger } from "../../src/utils/logger";
import { VoiceInputNormalizer } from "../../src/ui/voiceInput";
import { CommandCenter } from "../../src/ui/commandCenter";

describe("VoiceInputNormalizer, CommandCenter & DeterministicLogger", () => {
  test("VoiceInputNormalizer должен очищать слова-паразиты и распознавать голосовой откат", () => {
    const voice = new VoiceInputNormalizer();

    const res1 = voice.normalizeTranscript("Эээ ну короче пожалуйста добавь кеширование в auth.ts!");
    assert.equal(res1.normalizedText, "добавь кеширование в auth ts");
    assert.equal(res1.isRollbackCommand, false);

    const res2 = voice.normalizeTranscript("Слушай, ну откати назад пожалуйста");
    assert.equal(res2.isRollbackCommand, true);
  });

  test("CommandCenter должен детерминированно классифицировать интенты и находить файлы", () => {
    const center = new CommandCenter();

    const bugCmd = center.parseCommand("Исправь ошибку авторизации в auth.ts и user.ts");
    assert.equal(bugCmd.category, "BUGFIX");
    assert.deepEqual(bugCmd.targetMentions, ["auth.ts", "user.ts"]);

    const refactorCmd = center.parseCommand("Сделай рефакторинг модуля оплаты");
    assert.equal(refactorCmd.category, "REFACTOR");

    const voiceRollback = center.parseCommand("Эээ верни как было пожалуйста", true);
    assert.equal(voiceRollback.category, "ROLLBACK");
  });

  test("DeterministicLogger должен строить криптографическую хеш-цепочку записей", () => {
    const logger = new DeterministicLogger();

    const e1 = logger.info("Core", "Context extracted");
    const e2 = logger.warn("AutoFix", "Retry 1 triggered");
    const e3 = logger.info("Pipeline", "Patch applied");

    assert.equal(e1.index, 0);
    assert.equal(e2.prevHash, e1.entryHash);
    assert.equal(e3.prevHash, e2.entryHash);
    assert.equal(logger.verifyChainIntegrity(), true);
    assert.equal(logger.getEntries().length, 3);
  });
});
