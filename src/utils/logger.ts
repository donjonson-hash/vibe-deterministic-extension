import { computeDeterministicHash } from "./crypto";

export type LogLevel = "INFO" | "WARN" | "ERROR";

export interface AuditLogEntry {
  index: number;
  level: LogLevel;
  module: string;
  message: string;
  prevHash: string;
  entryHash: string;
}

export class DeterministicLogger {
  private entries: AuditLogEntry[] = [];
  private static readonly GENESIS_HASH = "0".repeat(64);

  public log(level: LogLevel, module: string, message: string): AuditLogEntry {
    const index = this.entries.length;
    const prevHash =
      index === 0
        ? DeterministicLogger.GENESIS_HASH
        : this.entries[index - 1].entryHash;

    const payload = JSON.stringify({ index, level, module, message, prevHash });
    const entryHash = computeDeterministicHash(payload);

    const entry: AuditLogEntry = Object.freeze({
      index,
      level,
      module,
      message,
      prevHash,
      entryHash,
    });

    this.entries.push(entry);
    return entry;
  }

  public info(module: string, message: string): AuditLogEntry {
    return this.log("INFO", module, message);
  }

  public warn(module: string, message: string): AuditLogEntry {
    return this.log("WARN", module, message);
  }

  public error(module: string, message: string): AuditLogEntry {
    return this.log("ERROR", module, message);
  }

  /**
   * Проверяет целостность всей цепочки логов от генезис-блока
   */
  public verifyChainIntegrity(): boolean {
    for (let i = 0; i < this.entries.length; i++) {
      const current = this.entries[i];
      const expectedPrev =
        i === 0 ? DeterministicLogger.GENESIS_HASH : this.entries[i - 1].entryHash;

      if (current.prevHash !== expectedPrev) {
        return false;
      }

      const expectedHash = computeDeterministicHash(
        JSON.stringify({
          index: current.index,
          level: current.level,
          module: current.module,
          message: current.message,
          prevHash: current.prevHash,
        })
      );

      if (current.entryHash !== expectedHash) {
        return false;
      }
    }
    return true;
  }

  public getEntries(): ReadonlyArray<AuditLogEntry> {
    return [...this.entries];
  }
}
