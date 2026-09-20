import { recordActionResult } from "./reviewActions.js";
import { storeReviewSources } from "./reviewSources.js";
import { reviewIdentity } from "./reviewIdentity.js";
import { rejectMissingCapability } from "./auth.js";
import {
  classifyCommunication,
  evaluateFulfilment,
  evaluateExpectedDeliverable,
  visibleCandidates,
  visibleSource,
  check,
} from "./operationalIntelligence.js";
import {
  briefing,
  createSession,
  session,
  presentSession,
  advance,
  respond,
  addAction,
} from "./reviewEngine.js";
import {
  readPromise,
  reviewPromise,
  promiseScope,
  PromiseError,
} from "./promiseLedger.js";

export function registerOperationalRoutes(app, database) {
  const route = (method, url, handler) =>
    app.route({
      method,
      url,
      handler: async (req, reply) => {
        const db = database(reply);
        if (!db) return reply;
        if (
          (req.body?.initiator_id || req.query?.initiator_id) &&
          rejectMissingCapability(req, reply, "threads:actor:assert")
        )
          return reply;
        if (
          url === "/review/actions/:id/result" &&
          rejectMissingCapability(req, reply, "review:execute")
        )
          return reply;
        if (
          url === "/review/owners" &&
          rejectMissingCapability(req, reply, "tenant:manage")
        )
          return reply;
        if (url === "/review/sources" && rejectMissingCapability(req, reply, "review:sources:write")) return reply;
        try {
          if (
            url.startsWith("/review/") &&
            url !== "/review/actions/:id/result" &&
            url !== "/review/owners" &&
            process.env.OWNER_REVIEW_ENABLED === "false"
          )
            throw new PromiseError(503, "Owner review is disabled");
          req.reviewIdentity = [
            "/review/actions/:id/result",
            "/review/owners",
          ].includes(url)
            ? { owner: `client:${req.authContext.keyId}`, scope: {} }
            : await reviewIdentity(db, req.authContext, input(req));
          return await handler(db, req);
        } catch (e) {
          return reply.code(e.status || 503).send({ error: e.message });
        }
      },
    });
  const input = (r) => {
    const value = r.method === "GET" ? r.query || {} : r.body || {};
    if (typeof value.allowed_project_ids === "string") {
      try {
        value.allowed_project_ids = JSON.parse(value.allowed_project_ids);
      } catch {
        throw new PromiseError(400, "Invalid project scope");
      }
    }
    return value;
  };
  const scope = (r) => r.reviewIdentity?.scope || promiseScope(input(r));
  const owner = (r) => r.reviewIdentity.owner;
  route("GET", "/review/sources", async (db, r) => r.reviewIdentity);
  route("POST", "/review/sources", (db, r) => storeReviewSources(db, r.reviewIdentity, r.body || {}));
  route("POST", "/review/owners", async (db, r) => {
    const b = r.body || {};
    if (
      !Number.isSafeInteger(b.expected_revision) ||
      typeof b.binding_key !== "string" ||
      !b.binding_key.trim() ||
      b.binding_key.length > 300 ||
      typeof b.person_id !== "string" ||
      typeof b.enabled !== "boolean" ||
      !Array.isArray(b.project_ids) ||
      b.project_ids.length > 200 ||
      b.project_ids.some((id) => typeof id !== "string" || !id.trim())
    )
      throw new PromiseError(
        400,
        "Version, binding key, owner contact, enabled and project IDs required",
      );
    return check(
      await db.rpc("configure_review_owner", {
        p_revision: b.expected_revision,
        p_key: b.binding_key,
        p_binding: {
          person_id: b.person_id,
          enabled: b.enabled,
          project_ids: b.project_ids,
          include_private: b.include_private === true,
        },
      }),
    );
  });
  route("GET", "/operational-objects", async (db, r) => {
    const rows = check(
      await db
        .from("operational_objects")
        .select("*")
        .order("created_at")
        .limit(500),
    );
    const result = [];
    for (const o of rows) {
      try {
        const source = await visibleSource(db, o.communication_id, scope(r));
        if (source.promise_revision === o.source_revision) result.push(o);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    return result;
  });
  route("POST", "/operational-objects/:id/resolve", async (db, r) => {
    const b = r.body || {};
    if (
      !["OPEN", "FULFILLED", "CANCELLED"].includes(b.status) ||
      typeof b.reason !== "string" ||
      !b.reason.trim() ||
      b.reason.length > 4000
    )
      throw new PromiseError(400, "Status and reason required");
    const o = check(
      await db
        .from("operational_objects")
        .select("*")
        .eq("id", r.params.id)
        .maybeSingle(),
    );
    if (!o) throw new PromiseError(404, "Object unavailable");
    const source = await visibleSource(db, o.communication_id, scope(r));
    if (
      source.promise_revision !== o.source_revision ||
      o.revision !== b.expected_revision
    )
      throw new PromiseError(409, "Object or source changed");
    const updated = check(
      await db
        .from("operational_objects")
        .update({
          status: b.status,
          revision: o.revision + 1,
          updated_at: new Date().toISOString(),
          history: [
            ...o.history,
            {
              actor: owner(r),
              reason: b.reason,
              status: b.status,
              at: new Date().toISOString(),
            },
          ],
        })
        .eq("id", o.id)
        .eq("revision", o.revision)
        .select("*")
        .maybeSingle(),
    );
    if (!updated) throw new PromiseError(409, "Object changed");
    return updated;
  });
  route("POST", "/operational-objects/:id/evaluate", (db, r) =>
    evaluateExpectedDeliverable(db, r.params.id, r.body, scope(r)),
  );
  route("POST", "/classifications", (db, r) =>
    classifyCommunication(db, r.body, scope(r)),
  );
  route("GET", "/classifications/candidates", (db, r) =>
    visibleCandidates(db, scope(r)),
  );
  route("POST", "/promises/:id/evaluate", (db, r) =>
    evaluateFulfilment(db, r.params.id, r.body, scope(r)),
  );
  for (const [suffix, action] of [
    ["confirm", "confirm"],
    ["fulfil", "verify_fulfillment"],
    ["cancel", "cancel"],
    ["reopen", "reopen"],
    ["supersede", "supersede"],
    ["reject-fulfilment", "reject_fulfilment"],
  ])
    route("POST", `/promises/:id/${suffix}`, async (db, r) => {
      const b = r.body || {};
      const p = await readPromise(db, r.params.id, scope(r));
      if (!p) throw new PromiseError(404, "Promise unavailable");
      if (["confirm", "verify_fulfillment", "cancel"].includes(action))
        return reviewPromise(db, p.id, { ...b, action }, owner(r), scope(r));
      if (
        action === "supersede" &&
        !(await readPromise(db, b.patch?.related_promise_id || "", scope(r)))
      )
        throw new PromiseError(404, "Replacement unavailable");
      return check(
        await db.rpc("transition_operational_promise", {
          p_id: p.id,
          p_revision: b.expected_revision,
          p_actor: owner(r),
          p_action: action,
          p_reason: b.reason,
          p_patch: b.patch || {},
        }),
      );
    });
  route("GET", "/review/briefing", (db, r) =>
    briefing(db, { ...input(r), ...scope(r) }, owner(r)),
  );
  route(
    "GET",
    "/review/items",
    async (db, r) =>
      (await briefing(db, { ...input(r), ...scope(r) }, owner(r))).review_queue,
  );
  route("POST", "/review/sessions", async (db, r) =>
    presentSession(
      await createSession(db, { ...input(r), ...scope(r) }, owner(r)),
    ),
  );
  route("GET", "/review/sessions/:id", async (db, r) =>
    presentSession(await session(db, r.params.id, owner(r), scope(r))),
  );
  route("POST", "/review/sessions/:id/advance", (db, r) =>
    advance(db, r.params.id, r.body, owner(r), scope(r)),
  );
  route("POST", "/review/sessions/:id/respond", (db, r) =>
    respond(db, r.params.id, r.body, owner(r), scope(r)),
  );
  route("POST", "/review/items/:id/respond", (db, r) =>
    respond(
      db,
      r.body.session_id,
      { ...r.body, review_item_id: r.params.id },
      owner(r),
      scope(r),
    ),
  );
  route("POST", "/review/sessions/:id/actions", (db, r) =>
    addAction(db, r.params.id, r.body, owner(r), scope(r)),
  );
  route("GET", "/review/sessions/:id/actions", async (db, r) => {
    await session(db, r.params.id, owner(r), scope(r));
    return check(
      await db
        .from("review_actions")
        .select("*")
        .eq("session_id", r.params.id)
        .order("created_at"),
    );
  });
  route("POST", "/review/actions/:id/result", async (db, r) => {
    return recordActionResult(db, r.params.id, r.body || {});
  });
}
