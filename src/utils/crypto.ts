import { createHash } from "crypto";

export function computeDeterministicHash(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
