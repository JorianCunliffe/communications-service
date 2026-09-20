import { check } from "./operationalIntelligence.js";
import { promiseScope, PromiseError } from "./promiseLedger.js";

// Bindings live in tenant policy, never in the request body. Delegated user IDs
// have already passed threads:actor:assert at the route boundary.
export async function reviewIdentity(db, auth, input = {}) {
  const tenant = check(
    await db
      .from("tenants")
      .select("metadata")
      .eq("tenant_id", db.tenantId)
      .maybeSingle(),
  );
  const policy = tenant?.metadata?.promise_ledger || {};
  const key = `${auth.keyId}${input.initiator_id ? `:user:${input.initiator_id}` : ""}`;
  const binding = policy.review_owners?.[key];
  const scope = promiseScope(input);
  if (policy.owner_review_enabled === false)
    throw new PromiseError(403, "Owner review is disabled");
  if (binding) {
    if (binding.enabled !== true || !binding.person_id)
      throw new PromiseError(403, "Review owner access revoked");
    scope.person_id = binding.person_id;
    if (Array.isArray(binding.project_ids))
      scope.allowed_project_ids = scope.allowed_project_ids
        ? scope.allowed_project_ids.filter((id) =>
            binding.project_ids.includes(id),
          )
        : binding.project_ids;
    if (Array.isArray(policy.project_ids))
      scope.allowed_project_ids = scope.allowed_project_ids
        ? scope.allowed_project_ids.filter((id) =>
            policy.project_ids.includes(id),
          )
        : policy.project_ids;
    if (
      scope.external_project_id &&
      scope.allowed_project_ids &&
      !scope.allowed_project_ids.includes(scope.external_project_id)
    )
      throw new PromiseError(403, "Review project unavailable");
    scope.include_private =
      scope.include_private && binding.include_private === true;
    return { owner: `person:${binding.person_id}`, scope };
  }
  return { owner: `client:${key}`, scope };
}
export function currentSessionScope(stored, current = {}) {
  if (stored.include_private && !current.include_private)
    throw new PromiseError(403, "Private review requires private capability");
  if (current.person_id && current.person_id !== stored.person_id)
    throw new PromiseError(403, "Review identity changed");
  if (current.allowed_project_ids) {
    if (
      stored.external_project_id &&
      !current.allowed_project_ids.includes(stored.external_project_id)
    )
      throw new PromiseError(403, "Review project access revoked");
    if (
      !stored.external_project_id &&
      (!stored.allowed_project_ids ||
        stored.allowed_project_ids.some(
          (id) => !current.allowed_project_ids.includes(id),
        ))
    )
      throw new PromiseError(403, "Review scope changed; start a fresh review");
  }
  return {
    ...stored,
    ...(current.allowed_project_ids
      ? { allowed_project_ids: current.allowed_project_ids }
      : {}),
  };
}
