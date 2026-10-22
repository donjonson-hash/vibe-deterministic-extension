import { computeDeterministicHash } from "../utils/crypto";
import { VoiceInputNormalizer } from "./voiceInput";

export type IntentCategory =
  | "REFACTOR"
  | "BUGFIX"
  | "FEATURE"
  | "TEST"
  | "ROLLBACK";

export interface ParsedVibeCommand {
  commandId: string;
  category: IntentCategory;
  canonicalIntent: string;
  targetMentions: string[];
}

export class CommandCenter {
  private readonly voiceNormalizer = new VoiceInputNormalizer();

  /**
   * Детерминированно разбирает текстовую или голосовую команду вайбкодера
   */
  public parseCommand(rawInput: string, isVoice = false): ParsedVibeCommand {
    const normalized = isVoice
      ? this.voiceNormalizer.normalizeTranscript(rawInput)
      : {
          rawTranscript: rawInput,
          normalizedText: rawInput.trim().replace(/\s+/g, " "),
          isRollbackCommand: /^(откат|отмени|rollback|undo)/i.test(rawInput.trim()),
          transcriptHash: computeDeterministicHash(rawInput.trim()),
        };

    const text = normalized.normalizedText;
    const category = normalized.isRollbackCommand
      ? "ROLLBACK"
      : this.detectCategory(text);

    // Извлекаем упомянутые файлы (например, auth.ts, index.ts)
    const fileMatches = text.match(/\b[\w-]+\.(?:ts|js|json)\b/gi) ?? [];
    const targetMentions = Array.from(new Set(fileMatches)).sort();

    const commandHash = computeDeterministicHash(`${category}:${text}`);

    return {
      commandId: `cmd_${commandHash.slice(0, 8)}`,
      category,
      canonicalIntent: text,
      targetMentions,
    };
  }

  private detectCategory(text: string): IntentCategory {
    const lower = text.toLowerCase();
    if (/(исправь|баг|ошибк|почини|fix|bug|error)/i.test(lower)) {
      return "BUGFIX";
    }
    if (/(тест|проверь|spec|test|assert)/i.test(lower)) {
      return "TEST";
    }
    if (/(рефактор|оптимизируй|упрости|перепиши|refactor|optimize|clean)/i.test(lower)) {
      return "REFACTOR";
    }
    return "FEATURE";
  }
}
