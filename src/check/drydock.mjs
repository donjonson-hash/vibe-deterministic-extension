// Import is evidence binding, not authentication or a proof of safety.
export const DRYDOCK_SCHEMA = "vibe-drydock-evidence-v1";
export function validateDrydockReport(report, candidateSha256, fileName) {
  const sha = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (
    !report ||
    report.schema !== DRYDOCK_SCHEMA ||
    report.runtime_verified !== false ||
    !["partial", "unavailable", "unknown"].includes(report.status) ||
    !sha(report.candidate_sha256) ||
    report.candidate_sha256 !== candidateSha256 ||
    report.file !== fileName ||
    !sha(report.source_snapshot_sha256) ||
    !sha(report.catalog_sha256) ||
    typeof report.engine_version !== "string" ||
    !report.engine_version ||
    !Array.isArray(report.findings) ||
    !Array.isArray(report.limitations) ||
    !report.limitations.every((x) => typeof x === "string") ||
    !report.limitations.includes("single_file_only")
  )
    throw Error("Invalid or stale Drydock evidence");
  return report;
}
