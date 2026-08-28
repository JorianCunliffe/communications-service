// Application-level tenant boundary for privileged database connections.
//
// Supabase service-role clients and the owning PostgreSQL role bypass RLS, so
// every service query still needs an explicit tenant predicate. This wrapper
// makes that predicate structural for HTTP request paths and also stamps every
// inserted tenant-owned row.

export const TENANT_TABLES = new Set([
    'contacts', 'contact_config', 'phone_configs', 'calls', 'sms_threads',
    'sms_messages', 'tool_calls', 'recordings', 'projects', 'project_contacts',
    'communications', 'communication_identities', 'communication_threads',
    'communication_thread_members', 'ask_bindings', 'outbound_operations',
    'outbound_events', 'calendar_events', 'calendar_event_participants',
    'communication_commitments', 'communication_facts',
    'communication_enrichment_jobs', 'call_outcome_jobs', 'provider_connections',
    'service_identities', 'webhook_receipts', 'communication_jobs',
    'communication_attachments', 'email_messages', 'email_reply_routes',
]);

const TENANT_RPCS = new Set([
    'create_communication_contact', 'ingest_calendar_event', 'requeue_communication_enrichment',
    'resolve_communication_ask', 'search_communications', 'suggest_terms',
]);

function withTenant(value, tenantId) {
    if (Array.isArray(value)) return value.map((row) => withTenant(row, tenantId));
    if (!value || typeof value !== 'object') return value;
    if (value.tenant_id && value.tenant_id !== tenantId) {
        throw new Error('Cross-tenant write rejected');
    }
    return { ...value, tenant_id: tenantId };
}

function scopedQuery(query, tenantId, owned) {
    let current = query;
    let scopeApplied = false;
    let mutation = null;
    let proxy;

    const applyScope = () => {
        if (owned && !mutation && !scopeApplied) {
            current.eq('tenant_id', tenantId);
            scopeApplied = true;
        } else if (owned && mutation && !scopeApplied) {
            // UPDATE and DELETE must also be scoped. INSERT/UPSERT have tenant
            // stamped in the payload and do not accept filters.
            if (mutation === 'update' || mutation === 'delete') {
                current.eq('tenant_id', tenantId);
            }
            scopeApplied = true;
        }
    };

    proxy = new Proxy(query, {
        get(target, property) {
            if (property === 'then') {
                return (resolve, reject) => {
                    applyScope();
                    return current.then(resolve, reject);
                };
            }
            const member = current[property];
            if (typeof member !== 'function') return member;
            return (...args) => {
                if (owned && (property === 'insert' || property === 'upsert')) {
                    args[0] = withTenant(args[0], tenantId);
                    mutation = property;
                } else if (property === 'update' || property === 'delete') {
                    mutation = property;
                }
                const result = member.apply(current, args);
                if (result && typeof result === 'object' && typeof result.then === 'function') {
                    current = result;
                    return proxy;
                }
                return result;
            };
        },
    });
    return proxy;
}

export function tenantDatabase(database, tenantId) {
    if (!database) return null;
    if (typeof tenantId !== 'string' || !tenantId.trim()) throw new Error('tenant_id is required');
    const canonicalTenant = tenantId.trim();
    return new Proxy(database, {
        get(target, property) {
            if (property === 'tenantId') return canonicalTenant;
            if (property === 'rpc') {
                return (name, args = {}) => {
                    if (!TENANT_RPCS.has(name)) return target.rpc(name, args);
                    if (args.p_tenant_id && args.p_tenant_id !== canonicalTenant) throw new Error('Cross-tenant RPC rejected');
                    return target.rpc(name, { p_tenant_id: canonicalTenant, ...args });
                };
            }
            if (property !== 'from') {
                const member = target[property];
                return typeof member === 'function' ? member.bind(target) : member;
            }
            return (table) => scopedQuery(target.from(table), canonicalTenant, TENANT_TABLES.has(table));
        },
    });
}

export function tenantFromRequest(request) {
    const header = request.headers?.['x-tenant-id'];
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const candidates = [header, body.tenant_id, body.correlation?.tenant_id, request.query?.tenant_id]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim());
    if (new Set(candidates).size > 1) throw new Error('Conflicting tenant_id values');
    return candidates[0] || null;
}
