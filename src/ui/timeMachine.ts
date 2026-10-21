import { computeDeterministicHash } from "../utils/crypto";
import { CodePatch } from "../llm/schemaParser";

export interface FileStateSnapshot {
  filePath: string;
  content: string;
  sha256: string;
}

export interface VibeSnapshot {
  id: string;
  intent: string;
  timestamp: number;
  files: ReadonlyArray<FileStateSnapshot>;
  snapshotHash: string;
}

export interface TransactionResult {
  snapshot: VibeSnapshot;
  updatedFiles: Map<string, string>;
}

export class TimeMachine {
  private history: VibeSnapshot[] = [];
  private readonly maxHistorySize: number;

  constructor(maxHistorySize = 50) {
    this.maxHistorySize = maxHistorySize;
  }

  /**
   * Создает неизменяемый детерминированный снапшот состояния файлов ДО применения патча LLM
   */
  public createSnapshot(
    intent: string,
    filesInput: Array<{ filePath: string; content: string }>,
    timestamp = Date.now()
  ): VibeSnapshot {
    const sortedFiles = [...filesInput]
      .sort((a, b) => a.filePath.localeCompare(b.filePath))
      .map((f) => ({
        filePath: f.filePath,
        content: f.content,
        sha256: computeDeterministicHash(f.content),
      }));

    const combinedPayload = JSON.stringify({
      intent,
      files: sortedFiles.map((f) => ({ filePath: f.filePath, sha256: f.sha256 })),
    });

    const snapshotHash = computeDeterministicHash(combinedPayload);
    const id = `snap_${timestamp}_${snapshotHash.slice(0, 8)}`;

    const snapshot: VibeSnapshot = Object.freeze({
      id,
      intent,
      timestamp,
      files: Object.freeze(sortedFiles),
      snapshotHash,
    });

    this.history.push(snapshot);

    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    return snapshot;
  }

  /**
   * Атомарная транзакция: сохраняет снапшот и применяет пачки патчей.
   * При малейшем сбое автоматически откатывает снапшот из истории.
   */
  public applyTransaction(
    intent: string,
    currentFiles: Array<{ filePath: string; content: string }>,
    patches: CodePatch[],
    timestamp = Date.now()
  ): TransactionResult {
    const snapshot = this.createSnapshot(intent, currentFiles, timestamp);
    const workingTree = new Map<string, string>(
      currentFiles.map((f) => [f.filePath, f.content])
    );

    try {
      for (const patch of patches) {
        const currentContent = workingTree.get(patch.targetFile);
        if (currentContent === undefined) {
          throw new Error(`TransactionError: Файл ${patch.targetFile} отсутствует в снапшоте`);
        }
        if (!currentContent.includes(patch.searchBlock)) {
          throw new Error(
            `TransactionError: Блок "${patch.searchBlock}" не найден в ${patch.targetFile}`
          );
        }
        workingTree.set(
          patch.targetFile,
          currentContent.replace(patch.searchBlock, patch.replaceBlock)
        );
      }

      return { snapshot, updatedFiles: workingTree };
    } catch (error) {
      // Автоматический откат созданного снапшота при сбое транзакции
      this.rollbackLast();
      throw error;
    }
  }

  /**
   * Проверяет криптографическую целостность снапшота перед откатом
   */
  public verifySnapshotIntegrity(snapshot: VibeSnapshot): boolean {
    for (const file of snapshot.files) {
      if (computeDeterministicHash(file.content) !== file.sha256) {
        return false;
      }
    }
    return true;
  }

  /**
   * Мгновенный откат последнего изменения (One-Click Rollback)
   */
  public rollbackLast(): VibeSnapshot | null {
    const snapshot = this.history.pop() ?? null;
    if (!snapshot) {
      return null;
    }

    if (!this.verifySnapshotIntegrity(snapshot)) {
      throw new Error(`IntegrityError: Снапшот ${snapshot.id} поврежден, хеш не совпадает`);
    }

    return snapshot;
  }

  /**
   * Откат к конкретному снапшоту по его ID (с очисткой более поздних состояний)
   */
  public rollbackTo(snapshotId: string): VibeSnapshot {
    const index = this.history.findIndex((s) => s.id === snapshotId);
    if (index === -1) {
      throw new Error(`SnapshotNotFound: Снапшот с ID "${snapshotId}" не найден в истории`);
    }

    const targetSnapshot = this.history[index];
    if (!this.verifySnapshotIntegrity(targetSnapshot)) {
      throw new Error(`IntegrityError: Снапшот ${targetSnapshot.id} поврежден`);
    }

    this.history.splice(index);
    return targetSnapshot;
  }

  /**
   * Возвращает список всех точек сохранения (от новых к старым)
   */
  public getHistory(): ReadonlyArray<VibeSnapshot> {
    return [...this.history].reverse();
  }
}
