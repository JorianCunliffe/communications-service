// Read-time evidence checks belong to Communications, not its consumers.
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
export function sourceAllowed(row, scope = {}) {
  if (!row || row.memory_eligible !== true || row.metadata?.retracted === true) return false;
  if (['spam','bounce','automatic_reply','mailing_list','system_generated','voicemail','no_answer','failed'].includes(row.disposition)) return false;
  if (row.channel === 'voice' && (row.metadata?.successful === false || row.metadata?.memory_eligible === false)) return false;
  if (scope.include_private !== true && (row.metadata?.private === true || ['private','restricted'].includes(row.metadata?.visibility))) return false;
  if (scope.project_id && row.project_id !== scope.project_id) return false;
  if (scope.external_project_id && row.correlation?.external_project_id !== scope.external_project_id) return false;
  if (scope.allowed_project_ids && !scope.allowed_project_ids.includes(row.correlation?.external_project_id)) return false;
  if (scope.person_id && (row.person_id || row.contact_id) !== scope.person_id) return false;
  if (scope.thread_id && row.thread_id !== scope.thread_id) return false;
  if (scope.calendar_event_id && row.calendar_event_id !== scope.calendar_event_id) return false;
  if (scope.channels && !scope.channels.includes(row.channel)) return false;
  if (scope.since && Date.parse(row.occurred_at) < Date.parse(scope.since)) return false;
  if (scope.until && Date.parse(row.occurred_at) >= Date.parse(scope.until)) return false;
  return true;
}

export function dueEvidence(row) {
  const wording = row.source_excerpt || ''; // A model description is not original source wording.
  const explicit = /\b20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})\b/i.exec(wording);
  const candidate = row.due_at || null;
  const supported = explicit && Number.isFinite(Date.parse(explicit[0])) && Date.parse(explicit[0]) === Date.parse(candidate);
  return { ...row, due_at: supported ? candidate : null, due_at_candidate: candidate,
    due_date_status: supported ? 'explicit' : candidate ? 'inferred' : 'unspecified',
    due_date_assumptions: supported ? [] : candidate ? ['Date or time inferred; requires confirmation'] : [],
    original_wording: wording || null, original_wording_status: wording ? 'available' : 'unavailable', evidence_only: true };
}

export async function safeMemory(db, result, scope = {}) {
  if (!result) return result;
  const ids = new Set();
  const askThreads=new Set();
  const collect = value => {
    if (!value || typeof value !== 'object') return;
    if (value.communication_id) ids.add(value.communication_id);
    if (value.type==='human_ask' && value.thread_id) askThreads.add(value.thread_id);
    for (const [key,item] of Object.entries(value)) {
      if ((key.endsWith('source_ids') || key === 'source_communication_ids') && Array.isArray(item)) item.forEach(id => ids.add(id));
      else if (key !== 'provenance') { if (Array.isArray(item)) item.forEach(collect); else if (typeof item === 'object') collect(item); }
    }
  };
  collect(result);
  const sources = new Map();
  const allIds = [...ids];
  for (let offset=0;offset<allIds.length;offset+=200) {
    const found = await db.from('communications').select('*').in('communication_id',allIds.slice(offset,offset+200));
    if (found.error) throw new Error(`Memory source validation unavailable: ${found.error.message}`);
    for (const row of found.data || []) sources.set(row.communication_id,row);
  }
  const allowedAsks=new Map();
  if (askThreads.size) {
    const found=await db.from('communications').select('*').in('thread_id',[...askThreads]).eq('memory_eligible',true);
    if (found.error) throw new Error('Memory Ask source validation unavailable');
    for (const source of found.data || []) if (sourceAllowed(source,scope) && source.purpose?.ask_id) {
      sources.set(source.communication_id,source);
      allowedAsks.set(source.purpose.ask_id,[...(allowedAsks.get(source.purpose.ask_id)||[]),source.communication_id]);
    }
  }
  let suppressed = false;
  const current = (sourceIds, derived, threadId) => {
    if (!sourceIds?.length) return false;
    return sourceIds.every(id => {
      const source = sources.get(id);
      return sourceAllowed(source,scope) && (!threadId || source.thread_id === threadId)
        && !(derived && source.updated_at && Date.parse(source.updated_at) > Date.parse(derived));
    });
  };
  const visit = (value,key='') => {
    if (Array.isArray(value)) return value.map(item=>visit(item,key)).filter(item=>item!==null);
    if (!value || typeof value !== 'object') return value;
    if (value.starts_at) {
      const external=value.metadata?.correlation?.external_project_id || value.metadata?.external_project_id;
      if ((scope.include_private !== true && (value.metadata?.private || ['private','restricted'].includes(value.metadata?.visibility)))
        || (scope.project_id && value.project_id!==scope.project_id)
        || (scope.external_project_id && external!==scope.external_project_id)
        || (scope.allowed_project_ids && !scope.allowed_project_ids.includes(external))) return null;
    }
    if (['person','contact','project','people','participants'].includes(key)) {
      if (key==='person' || key==='contact') return { id:value.id, name:value.name };
      if (key==='project') return { id:value.id, name:value.name };
      // Participant notes/configuration are not communication evidence.
      const personId=value.contact_id || value.person_id;
      if (personId && ![...sources.values()].some(source=>sourceAllowed(source,scope) && (source.person_id || source.contact_id)===personId)) return null;
      return { contact_id:value.contact_id, person_id:value.person_id, role:value.role };
    }
    if (value.communication_id && !value.description && !value.fact_key && !['commitments','open_commitments','facts','recent_facts','current_facts'].includes(key)) {
      const source=sources.get(value.communication_id);
      if (!sourceAllowed(source,scope)) { suppressed=true; return null; }
      return { ...value, ...source, via:sourceAllowed(sources.get(value.via),scope)?value.via:undefined, thread_id:source.thread_id, source: { communication_id:source.communication_id, channel:source.channel,
        occurred_at:source.occurred_at, updated_at:source.updated_at, href:`/v1/communications/${encodeURIComponent(source.communication_id)}` } };
    }
    if (value.fact_key || ['facts','recent_facts','current_facts','commitments','open_commitments'].includes(key) || (value.communication_id && value.description) || value.type==='commitment') {
      const sourceIds=value.source_communication_ids || [value.communication_id];
      const source=sources.get(sourceIds[0]);
      if (!current(sourceIds,value.updated_at,value.thread_id) || ['retracted','superseded'].includes(value.status)) { suppressed=true; return null; }
      if (!value.fact_key && value.source_excerpt && !clean(source?.body_them || source?.body).includes(clean(value.source_excerpt))) { suppressed=true; return null; }
      const safe={...value,source_communication_ids:sourceIds,evidence_only:true};
      return value.fact_key || key.includes('facts') ? safe : dueEvidence(safe);
    }
    if (value.type==='outstanding_state' && !current(value.source_communication_ids,value.updated_at,value.thread_id)) { suppressed=true; return null; }
    // Operational Ask bindings are not extracted promise evidence.
    if (value.type==='human_ask') return allowedAsks.has(value.ask_id) ? {...value,evidence_only:false,source_communication_ids:allowedAsks.get(value.ask_id)} : null;
    const next={};
    for (const [name,item] of Object.entries(value)) {
      if (name==='provenance') continue;
      next[name]=(name.endsWith('source_ids') || name==='source_communication_ids') && Array.isArray(item) ? item.filter(id=>sourceAllowed(sources.get(id),scope)) : visit(item,name);
    }
    if (value.thread_id && !value.channel && !value.type && !value.fact_key) {
      if (['threads','active_threads','recent_threads'].includes(key) && ![...sources.values()].some(source=>source.thread_id===value.thread_id && sourceAllowed(source,scope))) { suppressed=true; return null; }
      for (const [field,date] of [['summary','summary_updated_at'],['current_state','current_state_updated_at'],['outstanding_dependency','current_state_updated_at']]) {
        const sourceKey=field==='outstanding_dependency'?'outstanding_source_ids':field+'_source_ids';
        if (value[field] && !current(value[sourceKey],value[date],value.thread_id)) { next[field]=null; next[sourceKey]=[]; suppressed=true; }
      }
      {
        // A thread label may have been composed from a different audience's messages.
        for (const name of Object.keys(next)) if (!['thread_id','status','summary','summary_source_ids','summary_updated_at','current_state','current_state_source_ids','current_state_updated_at','outstanding_dependency','outstanding_source_ids','matching_communication_ids','score'].includes(name)) delete next[name];
        next.title=null; next.last_subject=null;
        if (next.matching_communication_ids) next.matching_communication_ids=next.matching_communication_ids.filter(id=>sourceAllowed(sources.get(id),scope));
      }
    }
    return next;
  };
  const safe=visit(result);
  if (safe?.thread && (scope.allowed_project_ids || scope.external_project_id || scope.person_id || scope.project_id) && ![...sources.values()].some(source=>source.thread_id===safe.thread.thread_id && sourceAllowed(source,scope))) return null;
  if (safe?.thread) { safe.summary=safe.thread.summary || null; safe.current_state=safe.thread.current_state || null; }
  if (Array.isArray(safe)) { Object.defineProperty(safe,'memory_status',{value:{state:suppressed?'stale':'current',retrieved_at:new Date().toISOString(),evidence_only:true}}); return safe; }
  if (Object.hasOwn(safe,'event') && !safe.event) return null;
  // Rebuild citations from the filtered payload, never retain rejected source IDs.
  const visible=new Set();
  const gather=value=>{if (!value||typeof value!=='object') return; if(value.source?.communication_id)visible.add(value.source.communication_id);
    for(const [key,item] of Object.entries(value)){if ((key.endsWith('source_ids')||key==='source_communication_ids')&&Array.isArray(item))item.forEach(id=>visible.add(id));else if(typeof item==='object')gather(item);}};
  gather(safe);
  safe.provenance={ summary:safe.thread?.summary_source_ids || [], current_state:safe.thread?.current_state_source_ids || [],
    facts:Object.fromEntries((safe.facts || safe.recent_facts || safe.current_facts || []).map(row=>[row.id,row.source_communication_ids])),
    commitments:Object.fromEntries((safe.commitments || safe.open_commitments || []).map(row=>[row.id,row.source_communication_ids])), sources:Object.fromEntries([...visible].filter(id=>sourceAllowed(sources.get(id),scope)).map(id=>[id,{href:`/v1/communications/${encodeURIComponent(id)}`,updated_at:sources.get(id).updated_at,channel:sources.get(id).channel,occurred_at:sources.get(id).occurred_at,excerpt:String(sources.get(id).body_them || sources.get(id).body || '').slice(0,4000)}])) };
  safe.memory_status={state:suppressed?'stale':'current',retrieved_at:new Date().toISOString(),evidence_only:true};
  return safe;
}
