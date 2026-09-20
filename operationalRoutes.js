import {rejectMissingCapability} from './auth.js';
import {classifyCommunication,evaluateFulfilment,visibleCandidates,visibleSource,check} from './operationalIntelligence.js';
import {briefing,createSession,session,presentSession,advance,respond,addAction} from './reviewEngine.js';
import {readPromise,reviewPromise,promiseScope,PromiseError} from './promiseLedger.js';

export function registerOperationalRoutes(app,database){
    const route=(method,url,handler)=>app.route({method,url,handler:async(req,reply)=>{const db=database(reply);if(!db)return reply;if((req.body?.initiator_id||req.query?.initiator_id)&&rejectMissingCapability(req,reply,'threads:actor:assert'))return reply;try{return await handler(db,req);}catch(e){return reply.code(e.status||503).send({error:e.message});}}});
    const input=r=>r.method==='GET'?r.query||{}:r.body||{};
    const scope=r=>promiseScope(input(r));
    const owner=r=>`client:${r.authContext.keyId}${input(r).initiator_id?`:user:${input(r).initiator_id}`:''}`;
    route('GET','/operational-objects',async(db,r)=>{
        const rows=check(await db.from('operational_objects').select('*').order('created_at').limit(500));const result=[];
        for(const o of rows){try{const source=await visibleSource(db,o.communication_id,scope(r));if(source.promise_revision===o.source_revision)result.push(o);}catch(e){if(e.status!==404)throw e;}}return result;
    });
    route('POST','/operational-objects/:id/resolve',async(db,r)=>{
        const b=r.body||{};if(!['OPEN','FULFILLED','CANCELLED'].includes(b.status)||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>4000)throw new PromiseError(400,'Status and reason required');
        const o=check(await db.from('operational_objects').select('*').eq('id',r.params.id).maybeSingle());if(!o)throw new PromiseError(404,'Object unavailable');
        const source=await visibleSource(db,o.communication_id,scope(r));if(source.promise_revision!==o.source_revision||o.revision!==b.expected_revision)throw new PromiseError(409,'Object or source changed');
        const updated=check(await db.from('operational_objects').update({status:b.status,revision:o.revision+1,updated_at:new Date().toISOString(),history:[...o.history,{actor:owner(r),reason:b.reason,status:b.status,at:new Date().toISOString()}]}).eq('id',o.id).eq('revision',o.revision).select('*').maybeSingle());
        if(!updated)throw new PromiseError(409,'Object changed');return updated;
    });
    route('POST','/classifications',(db,r)=>classifyCommunication(db,r.body,scope(r)));
    route('GET','/classifications/candidates',(db,r)=>visibleCandidates(db,scope(r)));
    route('POST','/promises/:id/evaluate',(db,r)=>evaluateFulfilment(db,r.params.id,r.body,scope(r)));
    for(const [suffix,action] of [['confirm','confirm'],['fulfil','verify_fulfillment'],['cancel','cancel'],['reopen','reopen'],['supersede','supersede'],['reject-fulfilment','reject_fulfilment']])route('POST',`/promises/:id/${suffix}`,async(db,r)=>{
        const b=r.body||{};const p=await readPromise(db,r.params.id,scope(r));if(!p)throw new PromiseError(404,'Promise unavailable');
        if(['confirm','verify_fulfillment','cancel'].includes(action))return reviewPromise(db,p.id,{...b,action},owner(r),scope(r));
        if(action==='supersede'&&!await readPromise(db,b.patch?.related_promise_id||'',scope(r)))throw new PromiseError(404,'Replacement unavailable');
        return check(await db.rpc('transition_operational_promise',{p_id:p.id,p_revision:b.expected_revision,p_actor:owner(r),p_action:action,p_reason:b.reason,p_patch:b.patch||{}}));
    });
    route('GET','/review/briefing',(db,r)=>briefing(db,input(r),owner(r)));
    route('GET','/review/items',async(db,r)=>(await briefing(db,input(r),owner(r))).review_queue);
    route('POST','/review/sessions',async(db,r)=>presentSession(await createSession(db,input(r),owner(r))));
    route('GET','/review/sessions/:id',async(db,r)=>presentSession(await session(db,r.params.id,owner(r),scope(r))));
    route('POST','/review/sessions/:id/advance',(db,r)=>advance(db,r.params.id,r.body,owner(r),scope(r)));
    route('POST','/review/sessions/:id/respond',(db,r)=>respond(db,r.params.id,r.body,owner(r),scope(r)));
    route('POST','/review/items/:id/respond',(db,r)=>respond(db,r.body.session_id,{...r.body,review_item_id:r.params.id},owner(r),scope(r)));
    route('POST','/review/sessions/:id/actions',(db,r)=>addAction(db,r.params.id,r.body,owner(r),scope(r)));
    route('GET','/review/sessions/:id/actions',async(db,r)=>{await session(db,r.params.id,owner(r),scope(r));return check(await db.from('review_actions').select('*').eq('session_id',r.params.id).order('created_at'));});
    route('POST','/review/actions/:id/result',async(db,r)=>{
        const b=r.body||{};if(!['SUCCEEDED','FAILED'].includes(b.status))throw new PromiseError(400,'Execution status required');
        const a=check(await db.from('review_actions').select('*').eq('id',r.params.id).maybeSingle());if(!a)throw new PromiseError(404,'Action unavailable');
        if(a.status!=='PENDING')return {id:a.id,status:a.status};
        const updated=check(await db.from('review_actions').update({status:b.status,result:b.result||{}}).eq('id',a.id).eq('status','PENDING').select('id,status').maybeSingle());
        return updated||{id:a.id,status:'ALREADY_REPORTED'};
    });
}
