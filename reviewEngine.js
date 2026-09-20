import { actionProposal } from "./reviewActions.js";
import { readReviewSources } from "./reviewSources.js";
import { currentSessionScope } from "./reviewIdentity.js";
import {
  listPromises,
  readPromise,
  promiseScope,
  PromiseError,
} from "./promiseLedger.js";
import {
  check,
  visibleCandidates,
  visibleSource,
  allRows,
  reviewSourceAllowed,
} from "./operationalIntelligence.js";
import { sourceAllowed } from "./memorySafety.js";

export function localDate(now, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function lifecycle(
  p,
  now = new Date(),
  timezone = "Australia/Brisbane",
) {
  if (p.observed_state === "fulfilled") return "FULFILLED";
  if (p.observed_state === "cancelled" || p.review_state === "dismissed")
    return "CANCELLED";
  if (p.observed_state === "superseded") return "SUPERSEDED";
  if (p.observed_state === "completion_claimed") return "FULFILMENT_SUSPECTED";
  if (p.review_state !== "confirmed") return "PROPOSED";
  if (p.conditions?.some((c) => c.status === "failed"))
    return "CONDITION_FAILED";
  if (p.conditions?.some((c) => c.status === "pending"))
    return "CONDITION_PENDING";
  const due = p.due_interpretation;
  if (
    ["explicit", "confirmed"].includes(due?.status) &&
    (due.instant
      ? Date.parse(due.instant) < now.getTime()
      : due.date_candidate &&
        due.date_candidate < localDate(now, due.timezone || timezone))
  )
    return "OVERDUE";
  return p.conditions?.length ? "READY" : "OPEN";
}
export function priority(p, now = new Date(), timezone = "Australia/Brisbane") {
  const state = lifecycle(p, now, timezone);
  const date =
    p.due_interpretation?.date_candidate ||
    p.due_interpretation?.instant?.slice(0, 10);
  let score =
    state === "OVERDUE"
      ? 30
      : date === localDate(now, timezone)
        ? 25
        : date &&
            Date.parse(date) - now.getTime() <= 172800000 &&
            Date.parse(date) >= now.getTime()
          ? 15
          : 0;
  if (p.promisee_parties?.length) score += 20;
  if (state === "FULFILMENT_SUSPECTED") score += 10;
  if (p.confidence < 0.8) score += 5;
  score += Math.max(0, Math.min(20, Number(p.project_importance) || 0));
  if (p.meeting_dependency) score += 15;
  return score;
}
export async function briefing(db, input = {}, owner = "api") {
  const scope = promiseScope(input);
  const now = new Date();
  const timezone = input.timezone || "Australia/Brisbane";
  try {
    localDate(now, timezone);
  } catch {
    throw new PromiseError(400, "Invalid timezone");
  }
  let promises = [],
    after;
  do {
    const page = await listPromises(db, { ...scope, limit: 100, after });
    promises.push(...page.data);
    after = page.next;
  } while (after);
  promises = promises
    .filter(
      (p) =>
        p.source_current &&
        !["retracted", "dismissed"].includes(p.review_state),
    )
    .map((p) => ({ ...p, lifecycle: lifecycle(p, now, timezone) }));
  const active = promises.filter(
    (p) => !["FULFILLED", "CANCELLED", "SUPERSEDED"].includes(p.lifecycle),
  );
  const candidates = await visibleCandidates(db, scope);
  const objects = await allRows(db, "operational_objects", (q) =>
    q.eq("status", "OPEN"),
  );
  const visible = [];
  for (const o of objects) {
    try {
      const s = await visibleSource(db, o.communication_id, {
        ...scope,
        person_id: undefined,
      });
      if (
        s.promise_revision === o.source_revision &&
        (await reviewSourceAllowed(db, s, scope, o.data))
      )
        visible.push(o);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  const end = new Date(now.getTime() + 7 * 86400000).toISOString();
  let calendar = await allRows(db, "calendar_events", (q) =>
    q
      .gte("starts_at", new Date(now.getTime() - 86400000).toISOString())
      .lte("starts_at", end),
  );
  calendar = calendar.filter(
    (e) =>
      e.metadata?.status !== "cancelled" &&
      (!e.metadata?.private || scope.include_private) &&
      (!scope.external_project_id ||
        e.metadata?.external_project_id === scope.external_project_id) &&
      (!scope.allowed_project_ids ||
        scope.allowed_project_ids.includes(e.metadata?.external_project_id)) &&
      (!scope.thread_id || e.communication_thread_id === scope.thread_id),
  );
  if (scope.person_id) {
    const participants = check(
      await db
        .from("calendar_event_participants")
        .select("event_id")
        .eq("contact_id", scope.person_id),
    );
    calendar = calendar.filter(
      (e) =>
        e.organiser_contact_id === scope.person_id ||
        participants.some((p) => p.event_id === e.id),
    );
  }
  const recent = [];
  for (const row of await allRows(db, "communications"))
    if (await reviewSourceAllowed(db, row, scope)) recent.push(row);
  recent.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
  const unanswered = recent.filter(
    (s) =>
      s.direction === "inbound" &&
      (s.metadata?.requires_response === true || visible.some(o => o.type === "REQUEST" && o.communication_id === s.communication_id)) &&
      !recent.some(
        (r) =>
          s.thread_id &&
          r.thread_id === s.thread_id &&
          r.direction === "outbound" &&
          r.occurred_at > s.occurred_at,
      ),
  );
  const last = check(
    await db
      .from("review_sessions")
      .select("completed_at")
      .eq("owner_id", owner)
      .eq("stage", "COMPLETED")
      .eq("scope", scope)
      .order("completed_at", { ascending: false })
      .limit(1),
  )[0]?.completed_at;
  const priorityPolicy =
    check(
      await db
        .from("tenants")
        .select("metadata")
        .eq("tenant_id", db.tenantId)
        .maybeSingle(),
    )?.metadata?.review_priority || {};
  for (const p of promises) {
    p.project_importance =
      priorityPolicy.projects?.[p.external_project_id] || 0;
    p.meeting_dependency = calendar.some((e) =>
      e.metadata?.promise_ids?.includes(p.id),
    );
  }
  const queue = [];
  for (const c of candidates) {
    const p = promises.find((p) => p.id === c.item.target_id);
    const type = c.item.type;
    let operation =
      type === "FULFILMENT_EVIDENCE"
        ? "verify_fulfillment"
        : type === "CANCELLATION"
          ? "cancel"
          : type === "CHANGE"
            ? "correct"
            : type === "DEPENDENCY" && c.item.condition_id
              ? "condition_update"
              : "acknowledge";
    if (
      ["PROMISE", "CONDITIONAL_PROMISE"].includes(type) &&
      p &&
      p.review_state !== "confirmed"
    )
      operation = "confirm";
    const patch =
      operation === "condition_update"
        ? { id: c.item.condition_id, status: "satisfied" }
        : operation === "correct"
          ? Object.keys(c.item.changes || {}).length
            ? c.item.changes
            : c.item.due_text &&
                ["explicit", "confirmed"].includes(c.item.due?.status)
              ? { due: { ...c.item.due, status: "confirmed" } }
              : {}
          : {};

    const clarification = operation === "correct" && !Object.keys(patch).length;
    queue.push({
      requires_clarification: clarification,
      id: c.id,
      candidate_id: c.id,
      type: "CANDIDATE",
      classification: type,
      promise_id: p?.id || null,
      ...(c.item.target_object_id
        ? { object_id: c.item.target_object_id }
        : {}),
      expected_revision: c.item.target_revision || p?.revision,
      operation,
      patch,
      proposal: {
        version: "review-proposal.v1",
        target_id: p?.id,
        expected_revision: c.item.target_revision || p?.revision,
        evidence: {
          communication_id: c.communication_id,
          source_revision: c.source_revision,
          quote: c.item.source_text,
        },
        changes: Object.entries(patch).map(([field, value]) => ({
          field,
          previous: field === "due" ? p?.due_interpretation : p?.[field],
          proposed: value,
          reason: c.item.summary,
        })),
      },
      question: `${c.item.summary}. ${
        c.item.target_object_id
          ? "Confirm the expected deliverable arrived?"
          : operation === "correct"
            ? `Confirm ${
                Object.entries(patch)
                  .map(([field, value]) =>
                    field === "due"
                      ? value.instant || value.date_candidate
                        ? `deadline ${value.instant || value.date_candidate} (${value.timezone || timezone})`
                        : "removing the deadline"
                      : `commitment: ${value}`,
                  )
                  .join("; ") || "the corrected terms"
              }?`
            : operation === "verify_fulfillment"
              ? "Confirm this promise was fulfilled?"
              : operation === "condition_update"
                ? "Confirm the condition is satisfied?"
                : "Accept this proposal?"
      }`,
      priority:
        (p ? priority(p, now, timezone) : 5) +
        (type === "FULFILMENT_EVIDENCE" ? 10 : 0),
      status: "PENDING",
    });
  }
  const rejected = await allRows(db, "operational_candidates", (q) =>
    q.eq("status", "REJECTED"),
  );
  for (const p of active) {
    if (
      rejected.some(
        (c) =>
          c.communication_id === p.communication_id &&
          c.source_revision === p.source_revision &&
          c.item.source_text === p.source_excerpt,
      )
    )
      continue;
    if (
      queue.some((q) => q.promise_id === p.id) ||
      candidates.some(
        (c) =>
          c.communication_id === p.communication_id &&
          c.item.source_text === p.source_excerpt,
      )
    )
      continue;
    const operation =
      p.lifecycle === "FULFILMENT_SUSPECTED"
        ? "verify_fulfillment"
        : p.lifecycle === "PROPOSED"
          ? "confirm"
          : p.lifecycle === "OVERDUE"
            ? "acknowledge"
            : null;
    if (operation)
      queue.push({
        id: `promise:${p.id}`,
        type: "PROMISE",
        promise_id: p.id,
        expected_revision: p.revision,
        operation,
        question:
          operation === "verify_fulfillment"
            ? `Has this been completed: ${p.description}?`
            : operation === "confirm"
              ? `Should I track this commitment: ${p.description}?`
              : `This is overdue: ${p.description}. Is it still outstanding?`,
        priority: priority(p, now, timezone),
        status: "PENDING",
      });
  }
  for (const o of visible.filter(
    (o) =>
      !queue.some((q) => q.object_id === o.id) &&
      ["EXPECTED_DELIVERABLE", "REQUEST"].includes(o.type) &&
      o.data.due?.date_candidate < localDate(now, timezone),
  ))
    queue.push({
      id: `object:${o.id}`,
      object_id: o.id,
      type: "EXPECTED_DELIVERABLE",
      expected_revision: o.revision,
      question: `We are waiting for: ${o.data.summary}. Has this arrived?`,
      priority: 30,
      status: "PENDING",
    });
  const tasks = await allRows(db, "review_tasks", (q) =>
    q.eq("owner_id", owner),
  );
  for (let i = queue.length - 1; i >= 0; i--) {
    const t = tasks.find((t) => t.item_id === queue[i].id);
    if (
      t &&
      (!t.history.at(-1)?.result_revision ||
        t.history.at(-1)?.result_revision === queue[i].expected_revision) &&
      (["RESOLVED", "DISMISSED"].includes(t.status) ||
        (t.status === "SNOOZED" && Date.parse(t.snoozed_until) > now.getTime()))
    )
      queue.splice(i, 1);
    else if (t) queue[i].priority += Math.min(t.times_raised, 10);
  }
  for (const q of queue) {
    const p = promises.find((p) => p.id === q.promise_id);
    q.priority_factors = {
      urgency:
        p?.lifecycle === "OVERDUE" ? "overdue" : p?.due_interpretation || null,
      external_people_waiting: !!p?.promisee_parties?.length,
      project_importance: p?.project_importance || 0,
      meeting_dependency: !!p?.meeting_dependency,
      repeated_questions:
        tasks.find((t) => t.item_id === q.id)?.times_raised || 0,
      uncertain: p?.confidence < 0.8,
    };
  }
  queue.sort(
    (a, b) =>
      (a.operation === "verify_fulfillment") -
        (b.operation === "verify_fulfillment") ||
      b.priority - a.priority ||
      a.id.localeCompare(b.id),
  );
  const tenant = check(
    await db
      .from("tenants")
      .select("metadata")
      .eq("tenant_id", db.tenantId)
      .maybeSingle(),
  );
  const observations = tenant?.metadata?.review_sources || {};
  const synchronized = await readReviewSources(db, owner, scope, now);
  if (synchronized.calendar?.last_success_at) {
    calendar = [...new Map(synchronized.calendar.items.map(item => [item.id, item])).values()];
  }
  const freshness = Object.fromEntries(
    ["calendar", "holds", "unanswered", "attachments"].map((name) => {
      const o = observations[name];
      if (synchronized[name]) {
        const {items, ...coverage} = synchronized[name];
        return [name, coverage];
      }
      return [
        name,
        {
          state: name === "calendar" ? "not_configured" : !o
            ? "not_configured"
            : o.error
              ? "unavailable"
              : Date.parse(o.last_success_at) > now.getTime() - 3600000
                ? "current"
                : "stale",
          last_success_at: o?.last_success_at || null,
          coverage_window: o?.coverage_window || null,
        },
      ];
    }),
  );
  const totalQuestions = queue.length;
  const maxItems = Math.max(1, Math.min(100, Number(input.max_items) || 100));
  queue.splice(maxItems);
  const date = localDate(now, timezone);
  const waiting = visible.filter(
    (o) => o.type === "EXPECTED_DELIVERABLE" || o.type === "REQUEST",
  );
  return {
    generated_at: now.toISOString(),
    timezone,
    calendar_items: calendar,
    promises_due: active.filter((p) => {
      const d = p.due_interpretation;
      return (
        (d?.instant && d.instant <= end) ||
        (d?.date_candidate && d.date_candidate <= end.slice(0, 10))
      );
    }),
    overdue_promises: active.filter((p) => p.lifecycle === "OVERDUE"),
    unconfirmed_fulfilments: queue.filter(
      (q) => q.operation === "verify_fulfillment",
    ),
    unmet_conditions: active.filter((p) =>
      p.conditions?.some((c) => c.status === "pending"),
    ),
    my_promises: active.filter((p) =>
      p.promisor_parties.some((x) => x.person_id === scope.person_id),
    ),
    promises_from_others: active.filter((p) =>
      p.promisee_parties.some((x) => x.person_id === scope.person_id),
    ),
    expected_deliverables: waiting.filter(
      (o) => o.type === "EXPECTED_DELIVERABLE",
    ),
    requests_awaiting_acceptance: waiting.filter((o) => o.type === "REQUEST"),
    missing_deliverables: waiting.filter(
      (o) => o.data.due?.date_candidate < date,
    ),
    unanswered_communications: unanswered,
    changed_since_last_review: last
      ? promises.filter((p) => p.updated_at > last)
      : promises,
    holds: synchronized.holds?.last_success_at ? synchronized.holds.items : recent
      .filter(
        (s) =>
          s.metadata?.hold_requires_human === true &&
          !["COMPLETED", "RESOLVED", "CANCELLED"].includes(
            s.metadata?.hold?.status,
          ) &&
          !recent.some(
            (r) =>
              r.metadata?.hold?.id &&
              r.metadata.hold.id === s.metadata?.hold?.id &&
              r.occurred_at > s.occurred_at &&
              ["COMPLETED", "RESOLVED", "CANCELLED"].includes(
                r.metadata.hold.status,
              ),
          ),
      )
      .map((s) => ({
        communication_id: s.communication_id,
        ...s.metadata.hold,
      })),
    review_queue: queue,
    max_items: maxItems,
    remaining_unraised: totalQuestions - queue.length,
    coverage: {
      calendar: synchronized.calendar?.last_success_at ? "configured_project_calendars" : "ingested_events_only",
      holds: synchronized.holds?.last_success_at ? "hyperflow_open_holds" : "ingested_hold_notifications_only",
      unanswered: "explicit_flags_and_open_classified_requests",
      freshness,
      truncated: false,
      attachment_content: "not_inspected",
    },
    text: `${freshness.calendar.state === "current" ? `Your configured project calendars have ${calendar.filter((e) => localDate(new Date(e.starts_at), timezone) === date).length} events today.` : `Calendar information is ${freshness.calendar.state.replace("_", " ")}; I cannot confirm your calendar is complete.`} ${active.filter((p) => p.lifecycle === "OVERDUE").length} promises are overdue. ${waiting.length} requests or deliverables are outstanding. I have ${queue.length} items to review${totalQuestions > queue.length ? `, with ${totalQuestions - queue.length} saved for a later review` : ""}.`,
  };
}
export async function createSession(db, input, owner) {
  if (
    input.request_id !== undefined &&
    (typeof input.request_id !== "string" ||
      !input.request_id.trim() ||
      input.request_id.length > 300)
  )
    throw new PromiseError(400, "Invalid session request_id");
  if (input.request_id) {
    const existing = check(
      await db
        .from("review_sessions")
        .select("*")
        .eq("owner_id", owner)
        .eq("request_id", input.request_id)
        .maybeSingle(),
    );
    if (existing) {
      if (
        JSON.stringify(existing.scope) !== JSON.stringify(promiseScope(input))
      ) {
        const a = Object.entries(existing.scope).sort(),
          b = Object.entries(promiseScope(input)).sort();
        if (JSON.stringify(a) !== JSON.stringify(b))
          throw new PromiseError(409, "Session request scope conflict");
      }
      return session(db, existing.id, owner, promiseScope(input));
    }
  }
  const data = await briefing(db, input, owner);
  const created = check(
    await db.rpc("create_review_session", {
      p_owner_id: owner,
      p_request_id: input.request_id || null,
      p_scope: promiseScope(input),
      p_briefing: data,
    }),
  );
  return session(db, created.id, owner, promiseScope(input));
}
export async function session(db, id, owner, scope = {}) {
  let s = check(
    await db
      .from("review_sessions")
      .select("*")
      .eq("id", id)
      .eq("owner_id", owner)
      .maybeSingle(),
  );
  if (!s) throw new PromiseError(404, "Session unavailable");
  s.scope = currentSessionScope(s.scope, scope);
  for (const q of s.review_queue) {
    if (
      q.promise_id &&
      !(await readPromise(db, q.promise_id, s.scope))?.source_current
    )
      throw new PromiseError(
        409,
        "Review evidence is no longer available; start a fresh session",
      );
    if (q.object_id) {
      const o = check(
        await db
          .from("operational_objects")
          .select("*")
          .eq("id", q.object_id)
          .maybeSingle(),
      );
      if (!o) throw new PromiseError(409, "Expected output unavailable");
      const source = await visibleSource(db, o.communication_id, {
        ...s.scope,
        person_id: undefined,
      });
      if (source.promise_revision !== o.source_revision)
        throw new PromiseError(409, "Expected output changed");
    }
    if (q.candidate_id) {
      const c = check(
        await db
          .from("operational_candidates")
          .select("*")
          .eq("id", q.candidate_id)
          .maybeSingle(),
      );
      const source = c
        ? check(
            await db
              .from("communications")
              .select("*")
              .eq("communication_id", c.communication_id)
              .maybeSingle(),
          )
        : null;
      if (
        !(await reviewSourceAllowed(db, source, s.scope, c?.item)) ||
        source.promise_revision !== c.source_revision
      )
        throw new PromiseError(
          409,
          "Review evidence changed; start a fresh session",
        );
    }
  }
  s = check(
    await db.rpc("refresh_review_session", {
      p_session_id: id,
      p_owner_id: owner,
    }),
  );
  s.briefing = await briefing(
    db,
    {
      ...s.scope,
      timezone: s.briefing.timezone,
      max_items: s.briefing.max_items,
    },
    owner,
  );
  s.action_results = check(
    await db
      .from("review_actions")
      .select("*")
      .eq("session_id", s.id)
      .order("created_at"),
  );
  return s;
}
export async function advance(db, id, input, owner, scope = {}) {
  const s = await session(db, id, owner, scope);
  const next = {
    BRIEFING: s.review_queue.some((q) => q.status === "PENDING")
      ? "REVIEW"
      : "NEXT_ACTIONS",
    NEXT_ACTIONS: "SUMMARY",
    SUMMARY: "COMPLETED",
  }[s.stage];
  if (!next)
    throw new PromiseError(409, "Answer or defer pending review items first");
  if (input.expected_revision !== s.revision)
    throw new PromiseError(409, "Session changed");
  const updated = check(
    await db
      .from("review_sessions")
      .update({
        stage: next,
        revision: s.revision + 1,
        ...(next === "COMPLETED"
          ? { completed_at: new Date().toISOString() }
          : {}),
      })
      .eq("id", id)
      .eq("revision", s.revision)
      .select("*")
      .maybeSingle(),
  );
  if (!updated) throw new PromiseError(409, "Session changed");
  return presentSession({ ...updated, action_results: s.action_results });
}
export function presentSession(s) {
  const changes = s.responses.filter((r) => r.result?.revision);
  const change_summary = changes.map((r) => ({
    object_id: r.object_id,
    operation: r.operation,
    revision: r.result_revision || r.result.revision,
  }));
  const actions = s.action_results || [];
  const completed = actions.filter((a) => a.status === "SUCCEEDED").length;
  const failed = actions.filter((a) => a.status === "FAILED").length;
  return {
    ...s,
    change_summary,
    prompt:
      s.stage === "BRIEFING"
        ? s.briefing.text
        : s.stage === "REVIEW"
          ? s.review_queue.find((q) => q.status === "PENDING")?.question
          : s.stage === "NEXT_ACTIONS"
            ? "That's everything I needed to confirm. Is there anything you'd like me to do?"
            : `${changes.length} recorded changes (${[...new Set(change_summary.map((c) => c.operation))].join(", ") || "none"}). ${actions.filter((a) => ["PENDING", "QUEUED", "RUNNING", "READY"].includes(a.status)).length} instructions queued, ${completed} completed, ${failed} failed. ${actions.filter((a) => a.status === "NEEDS_CLARIFICATION").length} need clarification. ${s.review_queue.filter((q) => q.status === "DEFERRED").length} items deferred. ${s.review_queue.filter((q) => q.status === "STALE").length} items require fresh evaluation.`,
    next_item: s.review_queue.find((q) => q.status === "PENDING") || null,
  };
}
export async function respond(db, id, input, owner, scope = {}) {
  const s = await session(db, id, owner, scope);
  const q = s.review_queue.find((q) => q.id === input.review_item_id);
  if (!q) throw new PromiseError(404, "Review item unavailable");
  if (
    typeof input.utterance !== "string" ||
    !input.utterance.trim() ||
    input.utterance.length > 4000 ||
    typeof input.request_id !== "string" ||
    !input.request_id.trim() ||
    input.request_id.length > 300
  )
    throw new PromiseError(400, "utterance and request_id required");
  // A natural answer is proposed to the caller; only an explicit structured decision commits it.
  if (
    (input.confidence !== undefined &&
      (!Number.isFinite(input.confidence) || input.confidence < 0.85)) ||
    input.requires_clarification === true ||
    !["ACCEPT", "REJECT", "DEFER", "PARTIAL", "CORRECT", "SNOOZE"].includes(
      input.intent,
    )
  )
    return {
      requires_clarification: true,
      question: "Please confirm accept, reject, or defer.",
      proposed_operations: [],
      utterance: input.utterance,
    };
  if (q.requires_clarification && input.intent === "ACCEPT")
    return {
      requires_clarification: true,
      question: "Which terms should change? Provide an explicit correction.",
      utterance: input.utterance,
      proposed_operations: [],
    };
  const details = {
    ...(input.details || {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
  };
  if (
    input.intent === "SNOOZE" &&
    (!details.snoozed_until ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(details.snoozed_until) ||
      Date.parse(details.snoozed_until) <= Date.now() ||
      !Number.isFinite(Date.parse(details.snoozed_until)))
  )
    throw new PromiseError(
      400,
      "Resolve a future snooze time including timezone",
    );
  if (input.intent === "CORRECT")
    await validateCorrection(db, q, details, s.scope);
  if (q.promise_id && !(await readPromise(db, q.promise_id, s.scope)))
    throw new PromiseError(404, "Promise unavailable");
  if (q.object_id) {
    const o = check(
      await db
        .from("operational_objects")
        .select("*")
        .eq("id", q.object_id)
        .maybeSingle(),
    );
    if (!o) throw new PromiseError(404, "Expected output unavailable");
    const source = await visibleSource(db, o.communication_id, {
      ...s.scope,
      person_id: undefined,
    });
    if (source.promise_revision !== o.source_revision)
      throw new PromiseError(409, "Expected output source changed");
  }
  if (q.candidate_id) {
    const candidates = await visibleCandidates(db, s.scope);
    if (
      !candidates.some((c) => c.id === q.candidate_id) &&
      !s.responses.some((r) => r.request_id === input.request_id)
    )
      throw new PromiseError(409, "Evidence changed; start a fresh review");
  }
  const updated = check(
    await db.rpc("respond_operational_review", {
      p_session_id: id,
      p_owner_id: owner,
      p_revision: input.expected_revision,
      p_item_id: input.review_item_id,
      p_intent: input.intent,
      p_utterance: input.utterance,
      p_request_id: input.request_id,
      p_destination: process.env.HYPERFLOW_EVENT_URL || null,
      p_details: details,
    }),
  );
  return presentSession({ ...updated, action_results: s.action_results });
}
export async function addAction(db, id, input, owner, scope = {}) {
  const s = await session(db, id, owner, scope);
  if (
    typeof input.instruction !== "string" ||
    !input.instruction.trim() ||
    input.instruction.length > 4000 ||
    typeof input.request_id !== "string" ||
    !input.request_id.trim()
  )
    throw new PromiseError(400, "instruction and request_id required");
  const proposal = await actionProposal(db, input, s.scope);
  return check(
    await db.rpc("queue_review_action", {
      p_session_id: id,
      p_owner_id: owner,
      p_request_id: input.request_id,
      p_instruction: input.instruction,
      p_destination:
        process.env.REVIEW_ACTION_DISPATCH_ENABLED === "true"
          ? process.env.HYPERFLOW_EVENT_URL || null
          : null,
      p_proposal: proposal,
      p_replaces: input.replaces_action_id || null,
    }),
  );
}

async function validateCorrection(db, q, details, scope) {
  if (!q.promise_id)
    throw new PromiseError(400, "Correction requires a promise");
  const patch = details.patch;
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    !Object.keys(patch).length
  )
    throw new PromiseError(400, "Explicit correction patch required");
  const allowed = [
    "description",
    "due",
    "promisor_parties",
    "promisee_parties",
    "id",
    "status",
    "related_promise_id",
  ];
  if (Object.keys(patch).some((k) => !allowed.includes(k)))
    throw new PromiseError(
      400,
      "Unsupported correction; project changes require the scoped promise API",
    );
  if (patch.due) {
    if (!["confirmed", "explicit", "unspecified"].includes(patch.due.status))
      throw new PromiseError(400, "Resolve the date before confirmation");
    if (patch.due.status === "unspecified" && details.clear_deadline !== true)
      throw new PromiseError(
        400,
        "Explicit deadline clearing confirmation required",
      );
    if (
      patch.due.instant &&
      (!Number.isFinite(Date.parse(patch.due.instant)) ||
        !/(Z|[+-]\d{2}:\d{2})$/.test(patch.due.instant))
    )
      throw new PromiseError(400, "Resolved deadline requires timezone");
    if (
      patch.due.date_candidate &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(patch.due.date_candidate) ||
        !patch.due.timezone)
    )
      throw new PromiseError(
        400,
        "Date-only deadline requires date and timezone",
      );
  }
  for (const key of ["promisor_parties", "promisee_parties"])
    if (patch[key]) {
      if (details.confirm_participants !== true || !Array.isArray(patch[key]))
        throw new PromiseError(400, "Confirm resolved participants explicitly");
      for (const party of patch[key])
        if (
          !party.person_id ||
          !check(
            await db
              .from("contacts")
              .select("id")
              .eq("id", party.person_id)
              .maybeSingle(),
          )
        )
          throw new PromiseError(400, "Participant unavailable");
    }
  if (
    patch.related_promise_id &&
    !(await readPromise(db, patch.related_promise_id, scope))
  )
    throw new PromiseError(404, "Replacement unavailable");
}
