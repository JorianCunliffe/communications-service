/** Verification secrets must never enter the durable model-tool audit. */
export function toolAuditArgs(name, args) {
  return name === "reception_verify" ||
    (name === "hyperflow_briefing" && args?.operation === "verify_code")
    ? { redacted: true }
    : args;
}
