import { check } from "./operationalIntelligence.js";
import { PromiseError } from "./promiseLedger.js";

export async function actionProposal(db, input, scope = {}) {
  const proposal = input.proposal;
  if (!proposal)
    return {
      version: "review-action.v1",
      authorization: "UNCONFIRMED",
      clarification: ["What action, recipient and schedule should I use?"],
    };
  if (
    proposal.version !== "review-action.v1" ||
    !["reminder", "email", "calendar", "task", "follow_up"].includes(
      proposal.type,
    )
  )
    throw new PromiseError(400, "Invalid action proposal");
  const p = structuredClone(proposal);
  p.authorization = input.authorized === true ? "CONFIRMED" : "UNCONFIRMED";
  p.clarification = [];
  p.parameters = p.parameters || {};
  if (typeof p.parameters !== "object" || Array.isArray(p.parameters))
    throw new PromiseError(400, "Typed action parameters required");
  if (
    !p.project_id ||
    (scope.external_project_id && scope.external_project_id !== p.project_id) ||
    (scope.allowed_project_ids &&
      !scope.allowed_project_ids.includes(p.project_id))
  )
    throw new PromiseError(400, "Authorized project required");
  const required = {
    email: ["recipient_person_id", "subject", "body"],
    follow_up: ["recipient_person_id", "subject", "body"],
    reminder: ["text", "scheduled_at"],
    calendar: ["calendar_key", "proposal_id", "hash"],
    task: ["title"],
  };
  for (const field of required[p.type])
    if (typeof p.parameters[field] !== "string" || !p.parameters[field].trim())
      p.clarification.push(`Resolve ${field}`);
  if(p.type==="calendar"&&(!Number.isSafeInteger(p.parameters.expected_revision)||p.parameters.expected_revision<1))p.clarification.push("Resolve the approved calendar proposal revision");
  if (p.parameters.recipient_person_id) {
    const contact = check(
      await db
        .from("contacts")
        .select("id,email")
        .eq("id", p.parameters.recipient_person_id)
        .maybeSingle(),
    );
    if (!contact?.email)
      p.clarification.push("Resolve a contact with an email address");
    else p.parameters.recipient_email = contact.email;
  }
  if (["reminder", "calendar"].includes(p.type)) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: p.timezone }).format();
      if (!p.timezone) throw Error();
    } catch {
      p.clarification.push("Resolve timezone");
    }
  }
  if (
    p.parameters.scheduled_at &&
    (!/(Z|[+-]\d{2}:\d{2})$/.test(p.parameters.scheduled_at) ||
      !Number.isFinite(Date.parse(p.parameters.scheduled_at)) ||
      Date.parse(p.parameters.scheduled_at) <= Date.now())
  )
    p.clarification.push("Resolve a future scheduled instant");
  return p;
}
export async function recordActionResult(db, id, input) {
  if (
    !["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(input.status) ||
    typeof input.receipt_id !== "string" ||
    !input.receipt_id.trim()
  )
    throw new PromiseError(400, "Execution status and receipt_id required");
  if (
    input.status === "SUCCEEDED" &&
    (!input.result?.provider_id ||
      !input.result?.completed_at ||
      !input.result?.summary)
  )
    throw new PromiseError(
      400,
      "Successful execution requires provider identity, completion time and outcome",
    );
  if (
    input.status === "SUCCEEDED" &&
    (!Number.isFinite(Date.parse(input.result.completed_at)) ||
      typeof input.result.provider_id !== "string" ||
      typeof input.result.summary !== "string")
  )
    throw new PromiseError(400, "Invalid provider execution evidence");
  return check(
    await db.rpc("record_review_action_result", {
      p_id: id,
      p_status: input.status,
      p_receipt_id: input.receipt_id,
      p_result: input.result || {},
    }),
  );
}
