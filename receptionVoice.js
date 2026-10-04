import { createHmac } from "node:crypto";
import { safeFetch } from "./safeFetch.js";
import { hyperflowProtectionHeaders } from "./vercelProtection.js";

export async function receptionCommand(
  operation,
  args,
  context,
  { fetchImpl = safeFetch } = {},
) {
  if (!context.reception || !context.toolCallId)
    throw new Error("An active reception session is required");
  const configured =
    process.env.HYPERFLOW_AGENT_CONTEXT_URL || process.env.HYPERFLOW_EVENT_URL;
  if (!configured || !process.env.COMMUNICATIONS_WEBHOOK_SECRET)
    throw new Error("Reception integration is unavailable");
  const url = new URL(configured);
  url.pathname = "/api/agent/reception";
  url.search = "";
  url.hash = "";
  const payload = {
    tenant_id: context.tenantId,
    person_id: context.personId,
    thread_id: context.threadId,
    communication_id: context.communicationId,
    service_identity: context.serviceIdentity,
    operation,
    operation_id: context.toolCallId,
    arguments: args,
  };
  const body = JSON.stringify(payload),
    timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac("sha256", process.env.COMMUNICATIONS_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
  const response = await fetchImpl(
    url.toString(),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-communications-timestamp": timestamp,
        "x-communications-signature-v2": signature,
        ...hyperflowProtectionHeaders(url.toString(), configured),
      },
      body,
      signal: context.signal || AbortSignal.timeout(15000),
    },
    {
      scope: "HYPERFLOW_AGENT_CONTEXT",
      allowedHosts: [url.hostname],
      maxRedirects: 0,
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "Reception operation unavailable");
  return result;
}
const string = { type: "string" };
const tool = (operation, description, properties, required = []) => ({
  type: "builtin",
  timeoutMs: 15000,
  description,
  parameters: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
  handler: (args, context) => receptionCommand(operation, args, context),
});
export const receptionTools = {
  reception_record_enquiry: tool(
    "record_enquiry",
    "Save this caller’s enquiry to the selected service, or the unassigned inbox. Say saved only after acknowledgement. Callback preferences are requests, not promises.",
    { name: string, request: string, callbackPreference: string },
    ["request"],
  ),
  reception_select_enquiry: tool(
    "select_enquiry",
    "Select one of the enquiry IDs returned for this caller and service. Ask which enquiry if ambiguous.",
    { enquiryId: string },
    ["enquiryId"],
  ),
  reception_verify: tool(
    "verify",
    "Send a short-lived code to the existing registered channel, or verify that code. Never ask for a password or login code.",
    { code: string },
  ),
  reception_select_ask: tool(
    "select_ask",
    "Bind this verified return call to one exact current staff request. Do this before collecting its answers to suppress outbound retries.",
    { askId: string },
    ["askId"],
  ),
  reception_pending_asks: tool(
    "pending_asks",
    "After verification, find current workflow questions addressed to this caller. Clarify if several; ask one question at a time.",
    {},
  ),
  reception_availability: tool(
    "availability",
    "Check current room availability using this service’s approved connection. Failure is not availability.",
    {},
  ),
  reception_prepare_action: tool(
    "prepare_action",
    "Prepare an inspection booking or partial staff answers. No effect yet. Read returned details aloud and obtain explicit confirmation. Use only returned Ask IDs. Ask one question at a time.",
    {
      kind: { type: "string", enum: ["booking", "ask"] },
      date: string,
      time: string,
      property: string,
      attendees: string,
      groupSize: { type: "integer" },
      askId: string,
      answers: { type: "object" },
      text: string,
      availabilityWindows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: string,
            start: string,
            end: string,
            properties: { type: "array", items: string },
          },
          required: ["date", "start", "end", "properties"],
          additionalProperties: false,
        },
      },
    },
    ["kind"],
  ),
  reception_reconcile_action: tool(
    "reconcile_action",
    "Inspect and reconcile the existing saved action after an uncertain response. Never dispatches a new effect.",
    {},
  ),
  reception_confirm_action: tool(
    "confirm_action",
    "Only after the caller confirms the exact proposal read back to them. An uncertain result must be reviewed, never retried under another ID.",
    { hash: string, confirmed: { type: "boolean" } },
    ["hash", "confirmed"],
  ),
};
export function receptionToolNames(context) {
  if (context.mode === "disabled") return [];
  return [
    "reception_record_enquiry",
    "reception_select_enquiry",
    ...(context.open ? ["reception_verify"] : []),
    ...(context.actions?.includes("resume_ask")
      ? ["reception_pending_asks", "reception_select_ask"]
      : []),
    ...(context.actions?.includes("availability")
      ? ["reception_availability"]
      : []),
    ...(context.actions?.some((a) => ["booking", "resume_ask"].includes(a))
      ? [
          "reception_prepare_action",
          "reception_confirm_action",
          "reception_reconcile_action",
        ]
      : []),
  ];
}

/** Delete every previous model conversation item on a service switch. No transcript
 * or tool output from the former service survives in the model context. */
export function clearReceptionContext(socket, itemIds, currentItemId) {
  for (const id of itemIds)
    if (id !== currentItemId) {
      socket.send(
        JSON.stringify({ type: "conversation.item.delete", item_id: id }),
      );
      itemIds.delete(id);
    }
}
