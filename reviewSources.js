import { PromiseError } from './promiseLedger.js';
import { allRows, check } from './operationalIntelligence.js';

export async function storeReviewSources(db, identity, input, now = new Date()) {
  const {owner, scope} = identity;
  if (!owner.startsWith('person:')) throw new PromiseError(403, 'Configure a canonical review owner first');
  const rows = input.snapshots;
  if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw new PromiseError(400, 'Invalid source snapshots');
  for (const s of rows) {
    if (!s || !['calendar','holds'].includes(s.source) || !['current','unavailable','not_configured'].includes(s.state)
      || typeof s.project_id !== 'string' || !scope.allowed_project_ids?.includes(s.project_id)
      || (scope.external_project_id && s.project_id !== scope.external_project_id)) throw new PromiseError(403, 'Source project unavailable');
    const observed = Date.parse(s.observed_at);
    if (!Number.isFinite(observed) || observed > now.getTime() + 60000 || observed < now.getTime() - 3600000
      || !Array.isArray(s.items) || s.items.length > 2000 || (s.state !== 'current' && s.items.length)
      || JSON.stringify(s).length > 500000) throw new PromiseError(400, 'Invalid source observation');
    if (s.source === 'calendar' && s.state === 'current') {
      const from = Date.parse(s.coverage_window?.start), to = Date.parse(s.coverage_window?.end);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to-from > 31*86400000) throw new PromiseError(400, 'Calendar coverage window required');
    }
    for (const item of s.items) {
      if (!item || typeof item.id !== 'string' || !item.id || item.project_id !== s.project_id) throw new PromiseError(400, 'Invalid source item');
      if (s.source === 'calendar' && (!Number.isFinite(Date.parse(item.starts_at)) || !Number.isFinite(Date.parse(item.ends_at)))) throw new PromiseError(400, 'Invalid calendar interval');
      if (s.source === 'holds' && !['waiting','processing'].includes(item.status)) throw new PromiseError(400, 'Only open holds belong in a snapshot');
    }
  }
  return check(await db.rpc('store_review_sources', {p_owner_id:owner,p_snapshots:rows}));
}

export async function readReviewSources(db, owner, scope, now = new Date()) {
  // Only exact currently permitted projects count towards complete coverage.
  // Legacy tenant-wide metadata cannot prove an owner's calendar coverage.
  const projects = scope.external_project_id ? [scope.external_project_id] : scope.allowed_project_ids;
  if (!owner.startsWith('person:') || !projects || scope.thread_id) return {};
  const rows = await allRows(db,'review_source_snapshots',q=>q.eq('owner_id',owner));
  const result = {};
  for (const source of ['calendar','holds']) {
    const observations = projects.map(id=>rows.find(r=>r.project_id===id && r.source===source)?.observation);
    const complete = observations.length > 0 && observations.every(Boolean);
    const state = !complete ? 'not_configured' : observations.some(o=>o.state==='unavailable') ? 'unavailable'
      : observations.some(o=>o.state==='not_configured') ? 'not_configured'
      : observations.some(o=>Date.parse(o.observed_at)<now.getTime()-3600000) ? 'stale' : 'current';
    result[source] = {state, items: observations.flatMap(o=>o?.items || []),
      last_success_at: complete && observations.every(o=>o.state==='current') ? observations.map(o=>o.observed_at).sort()[0] : null,
      coverage_window: source==='calendar' && complete && observations.every(o=>o.coverage_window) ? {
        start:observations.map(o=>o.coverage_window.start).sort().at(-1),end:observations.map(o=>o.coverage_window.end).sort()[0]
      }: null,
      scope:'configured_project_sources', projects: projects.length};
    if (source==='calendar' && result[source].state==='current' &&
      !(Date.parse(result[source].coverage_window?.start)<=now.getTime() && Date.parse(result[source].coverage_window?.end)>now.getTime())) result[source].state='stale';
  }
  return result;
}
