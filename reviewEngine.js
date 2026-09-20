import {listPromises,readPromise,promiseScope,PromiseError} from './promiseLedger.js';
import {check,visibleCandidates,visibleSource} from './operationalIntelligence.js';
import {sourceAllowed} from './memorySafety.js';

export function localDate(now,timezone){return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export function lifecycle(p,now=new Date(),timezone='Australia/Brisbane') {
    if(p.observed_state==='fulfilled')return 'FULFILLED';
    if(p.observed_state==='cancelled'||p.review_state==='dismissed')return 'CANCELLED';
    if(p.observed_state==='superseded')return 'SUPERSEDED';
    if(p.observed_state==='completion_claimed')return 'FULFILMENT_SUSPECTED';
    if(p.review_state!=='confirmed')return 'PROPOSED';
    if(p.conditions?.some(c=>c.status==='pending'))return 'CONDITION_PENDING';
    const due=p.due_interpretation;
    if(['explicit','confirmed'].includes(due?.status)&&(due.instant?Date.parse(due.instant)<now.getTime():due.date_candidate&&due.date_candidate<localDate(now,due.timezone||timezone)))return 'OVERDUE';
    return p.conditions?.length?'READY':'OPEN';
}
export function priority(p,now=new Date(),timezone='Australia/Brisbane'){
    const state=lifecycle(p,now,timezone);const date=p.due_interpretation?.date_candidate||p.due_interpretation?.instant?.slice(0,10);
    let score=state==='OVERDUE'?30:date===localDate(now,timezone)?25:date&&Date.parse(date)-now.getTime()<=172800000&&Date.parse(date)>=now.getTime()?15:0;
    if(p.promisee_parties?.length)score+=20;
    if(state==='FULFILMENT_SUSPECTED')score+=10;
    if(p.confidence<0.8)score+=5;
    return score;
}
export async function briefing(db,input={},owner='api'){
    const scope=promiseScope(input);const now=new Date();const timezone=input.timezone||'Australia/Brisbane';
    try{localDate(now,timezone);}catch{throw new PromiseError(400,'Invalid timezone');}
    let promises=[],after;
    do{const page=await listPromises(db,{...scope,limit:100,after});promises.push(...page.data);after=page.next;}while(after);
    promises=promises.filter(p=>p.source_current&&!['retracted','dismissed'].includes(p.review_state)).map(p=>({...p,lifecycle:lifecycle(p,now,timezone)}));
    const active=promises.filter(p=>!['FULFILLED','CANCELLED','SUPERSEDED'].includes(p.lifecycle));
    const candidates=await visibleCandidates(db,scope);
    const objects=check(await db.from('operational_objects').select('*').eq('status','OPEN').order('created_at').limit(500));
    const visible=[];
    for(const o of objects){try{const s=await visibleSource(db,o.communication_id,scope);if(s.promise_revision===o.source_revision)visible.push(o);}catch(e){if(e.status!==404)throw e;}}
    const end=new Date(now.getTime()+7*86400000).toISOString();
    let calendar=check(await db.from('calendar_events').select('*').gte('starts_at',new Date(now.getTime()-86400000).toISOString()).lte('starts_at',end).order('starts_at').limit(200));
    calendar=calendar.filter(e=>e.metadata?.status!=='cancelled'&&(!e.metadata?.private||scope.include_private)&&(!scope.external_project_id||e.metadata?.external_project_id===scope.external_project_id)&&(!scope.allowed_project_ids||scope.allowed_project_ids.includes(e.metadata?.external_project_id))&&(!scope.thread_id||e.communication_thread_id===scope.thread_id));
    if(scope.person_id){const participants=check(await db.from('calendar_event_participants').select('event_id').eq('contact_id',scope.person_id));calendar=calendar.filter(e=>e.organiser_contact_id===scope.person_id||participants.some(p=>p.event_id===e.id));}
    const recent=check(await db.from('communications').select('*').order('occurred_at',{ascending:false}).limit(500));
    const unanswered=recent.filter(s=>sourceAllowed(s,scope)&&s.direction==='inbound'&&s.metadata?.requires_response===true&&!recent.some(r=>r.thread_id===s.thread_id&&r.direction==='outbound'&&r.occurred_at>s.occurred_at));
    const last=check(await db.from('review_sessions').select('completed_at').eq('owner_id',owner).eq('stage','COMPLETED').order('completed_at',{ascending:false}).limit(1))[0]?.completed_at;
    const queue=[];
    for(const c of candidates){const p=promises.find(p=>p.id===c.item.target_id);const type=c.item.type;
        const operation=type==='FULFILMENT_EVIDENCE'?'verify_fulfillment':type==='CANCELLATION'?'cancel':type==='CHANGE'?'correct':type==='DEPENDENCY'&&c.item.condition_id?'condition_update':'acknowledge';
        const patch=operation==='condition_update'?{id:c.item.condition_id,status:'satisfied'}:operation==='correct'?{due:{...c.item.due,status:c.item.due?.instant||c.item.due?.date_candidate?'confirmed':'unspecified'}}:{};
        queue.push({id:c.id,candidate_id:c.id,type:'CANDIDATE',classification:type,promise_id:p?.id||null,expected_revision:p?.revision,operation,patch,question:`${c.item.summary}. ${operation==='verify_fulfillment'?'Confirm this promise was fulfilled?':operation==='condition_update'?'Confirm the condition is satisfied?':'Accept this proposal?'}`,priority:(p?priority(p,now,timezone):5)+(type==='FULFILMENT_EVIDENCE'?10:0),status:'PENDING'});
    }
    for(const p of active){if(queue.some(q=>q.promise_id===p.id)||candidates.some(c=>c.communication_id===p.communication_id&&c.item.source_text===p.source_excerpt))continue;
        const operation=p.lifecycle==='FULFILMENT_SUSPECTED'?'verify_fulfillment':p.lifecycle==='PROPOSED'?'confirm':p.lifecycle==='OVERDUE'?'acknowledge':null;
        if(operation)queue.push({id:`promise:${p.id}`,type:'PROMISE',promise_id:p.id,expected_revision:p.revision,operation,question:operation==='verify_fulfillment'?`Has this been completed: ${p.description}?`:operation==='confirm'?`Should I track this commitment: ${p.description}?`:`This is overdue: ${p.description}. Is it still outstanding?`,priority:priority(p,now,timezone),status:'PENDING'});
    }
    for(const o of visible.filter(o=>['EXPECTED_DELIVERABLE','REQUEST'].includes(o.type)&&o.data.due?.date_candidate<localDate(now,timezone)))queue.push({id:`object:${o.id}`,object_id:o.id,type:'EXPECTED_DELIVERABLE',expected_revision:o.revision,question:`We are waiting for: ${o.data.summary}. Has this arrived?`,priority:30,status:'PENDING'});
    queue.sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id));
    const date=localDate(now,timezone);const waiting=visible.filter(o=>o.type==='EXPECTED_DELIVERABLE'||o.type==='REQUEST');
    return {generated_at:now.toISOString(),timezone,calendar_items:calendar,promises_due:active.filter(p=>{const d=p.due_interpretation;return d?.instant&&d.instant<=end||d?.date_candidate&&d.date_candidate<=end.slice(0,10);}),overdue_promises:active.filter(p=>p.lifecycle==='OVERDUE'),unconfirmed_fulfilments:queue.filter(q=>q.operation==='verify_fulfillment'),unmet_conditions:active.filter(p=>p.conditions?.some(c=>c.status==='pending')),my_promises:active.filter(p=>p.promisor_parties.some(x=>x.person_id===scope.person_id)),promises_from_others:active.filter(p=>p.promisee_parties.some(x=>x.person_id===scope.person_id)),expected_deliverables:waiting,missing_deliverables:waiting.filter(o=>o.data.due?.date_candidate<date),unanswered_communications:unanswered,changed_since_last_review:last?promises.filter(p=>p.updated_at>last):promises,holds:recent.filter(s=>sourceAllowed(s,scope)&&s.metadata?.hold_requires_human===true).map(s=>({communication_id:s.communication_id,...s.metadata.hold})),review_queue:queue,coverage:{calendar:'ingested_events_only',holds:'ingested_hold_notifications_only',unanswered:'explicit_requires_response_only',candidate_limit:500,communication_limit:500},text:`You have ${calendar.filter(e=>localDate(new Date(e.starts_at),timezone)===date).length} calendar events today. ${active.filter(p=>p.lifecycle==='OVERDUE').length} promises are overdue. ${waiting.length} requests or deliverables are outstanding. I have ${queue.length} items to review.`};
}
export async function createSession(db,input,owner){
    const data=await briefing(db,input,owner);
    return check(await db.from('review_sessions').insert({owner_id:owner,scope:promiseScope(input),briefing:data,review_queue:data.review_queue}).select('*').single());
}
export async function session(db,id,owner,scope={}){
    const s=check(await db.from('review_sessions').select('*').eq('id',id).eq('owner_id',owner).maybeSingle());
    if(!s)throw new PromiseError(404,'Session unavailable');
    if(s.scope.include_private&&!scope.include_private)throw new PromiseError(403,'Private review requires private capability');
    for (const q of s.review_queue) {
        if(q.promise_id && !(await readPromise(db,q.promise_id,s.scope))?.source_current)throw new PromiseError(409,'Review evidence is no longer available; start a fresh session');
        if(q.object_id){const o=check(await db.from('operational_objects').select('*').eq('id',q.object_id).maybeSingle());
            if(!o)throw new PromiseError(409,'Expected output unavailable');
            const source=await visibleSource(db,o.communication_id,s.scope);
            if(source.promise_revision!==o.source_revision)throw new PromiseError(409,'Expected output changed');
        }
        if(q.candidate_id){
            const c=check(await db.from('operational_candidates').select('*').eq('id',q.candidate_id).maybeSingle());
            const source=c?check(await db.from('communications').select('*').eq('communication_id',c.communication_id).maybeSingle()):null;
            if(!sourceAllowed(source,s.scope)||source.promise_revision!==c.source_revision)throw new PromiseError(409,'Review evidence changed; start a fresh session');
        }
    }
    s.briefing=await briefing(db,{...s.scope,timezone:s.briefing.timezone},owner);
    s.action_results=check(await db.from('review_actions').select('*').eq('session_id',s.id).order('created_at'));
    return s;
}
export async function advance(db,id,input,owner,scope={}){
    const s=await session(db,id,owner,scope);const next={BRIEFING:s.review_queue.some(q=>q.status==='PENDING')?'REVIEW':'NEXT_ACTIONS',NEXT_ACTIONS:'SUMMARY',SUMMARY:'COMPLETED'}[s.stage];
    if(!next)throw new PromiseError(409,'Answer or defer pending review items first');
    if(input.expected_revision!==s.revision)throw new PromiseError(409,'Session changed');
    const updated=check(await db.from('review_sessions').update({stage:next,revision:s.revision+1,...(next==='COMPLETED'?{completed_at:new Date().toISOString()}:{})}).eq('id',id).eq('revision',s.revision).select('*').maybeSingle());
    if(!updated)throw new PromiseError(409,'Session changed');return presentSession({...updated,action_results:s.action_results});
}
export function presentSession(s){
    const changes=s.responses.filter(r=>r.intent==='ACCEPT');
    const actions=s.action_results||[];const completed=actions.filter(a=>a.status==='SUCCEEDED').length;const failed=actions.filter(a=>a.status==='FAILED').length;
    return {...s,prompt:s.stage==='BRIEFING'?s.briefing.text:s.stage==='REVIEW'?s.review_queue.find(q=>q.status==='PENDING')?.question:s.stage==='NEXT_ACTIONS'?"That's everything I needed to confirm. Is there anything you'd like me to do?":`${changes.length} review decisions accepted. ${s.actions_created.length-completed-failed} instructions queued, ${completed} completed, ${failed} failed. ${s.review_queue.filter(q=>q.status==='DEFERRED').length} items deferred.`,next_item:s.review_queue.find(q=>q.status==='PENDING')||null};
}
export async function respond(db,id,input,owner,scope={}){
    const s=await session(db,id,owner,scope);const q=s.review_queue.find(q=>q.id===input.review_item_id);
    if(!q)throw new PromiseError(404,'Review item unavailable');
    if(typeof input.utterance!=='string'||!input.utterance.trim()||input.utterance.length>4000||typeof input.request_id!=='string'||!input.request_id.trim()||input.request_id.length>300)throw new PromiseError(400,'utterance and request_id required');
    // A natural answer is proposed to the caller; only an explicit structured decision commits it.
    if(!['ACCEPT','REJECT','DEFER'].includes(input.intent))return {requires_clarification:true,question:'Please confirm accept, reject, or defer.',proposed_operations:[],utterance:input.utterance};
    if(q.promise_id&&!await readPromise(db,q.promise_id,s.scope))throw new PromiseError(404,'Promise unavailable');
    if(q.object_id){const o=check(await db.from('operational_objects').select('*').eq('id',q.object_id).maybeSingle());if(!o)throw new PromiseError(404,'Expected output unavailable');const source=await visibleSource(db,o.communication_id,s.scope);if(source.promise_revision!==o.source_revision)throw new PromiseError(409,'Expected output source changed');}
    if(q.candidate_id){const candidates=await visibleCandidates(db,s.scope);if(!candidates.some(c=>c.id===q.candidate_id)&&!s.responses.some(r=>r.request_id===input.request_id))throw new PromiseError(409,'Evidence changed; start a fresh review');}
    return presentSession(check(await db.rpc('respond_operational_review',{p_session_id:id,p_owner_id:owner,p_revision:input.expected_revision,p_item_id:input.review_item_id,p_intent:input.intent,p_utterance:input.utterance,p_request_id:input.request_id,p_destination:process.env.HYPERFLOW_EVENT_URL||null})));
}
export async function addAction(db,id,input,owner,scope={}){
    await session(db,id,owner,scope);
    if(typeof input.instruction!=='string'||!input.instruction.trim()||input.instruction.length>4000||typeof input.request_id!=='string'||!input.request_id.trim())throw new PromiseError(400,'instruction and request_id required');
    return check(await db.rpc('queue_review_action',{p_session_id:id,p_owner_id:owner,p_request_id:input.request_id,p_instruction:input.instruction,p_destination:process.env.HYPERFLOW_EVENT_URL||null}));
}
