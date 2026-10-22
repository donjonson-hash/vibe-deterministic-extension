import { computeDeterministicHash } from "../utils/crypto";

export interface NormalizedVoiceIntent {
  rawTranscript: string;
  normalizedText: string;
  isRollbackCommand: boolean;
  transcriptHash: string;
}

export class VoiceInputNormalizer {
  private static readonly FILLER_WORDS = [
    "эээ",
    "хмм",
    "ну",
    "короче",
    "слушай",
    "пожалуйста",
    "типа",
    "как бы",
    "uh",
    "um",
    "like",
    "please",
  ];

  private static readonly ROLLBACK_TRIGGERS = [
    "откати назад",
    "отмени изменения",
    "верни как было",
    "rollback",
    "undo last vibe",
  ];

  /**
   * Очищает голосовую транскрипцию от слов-паразитов и приводит к детерминированному виду
   */
  public normalizeTranscript(rawTranscript: string): NormalizedVoiceIntent {
    let cleaned = rawTranscript.toLowerCase().trim();

    for (const filler of VoiceInputNormalizer.FILLER_WORDS) {
      const regex = new RegExp(`(?:^|\\s+)${filler}(?=\\s+|$|[,.!?])`, "gi");
      cleaned = cleaned.replace(regex, " ");
    }

    cleaned = cleaned
      .replace(/[,.!?]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const isRollbackCommand = VoiceInputNormalizer.ROLLBACK_TRIGGERS.some((trigger) =>
      cleaned.includes(trigger)
    );

    return {
      rawTranscript,
      normalizedText: cleaned,
      isRollbackCommand,
      transcriptHash: computeDeterministicHash(cleaned),
    };
  }
}
