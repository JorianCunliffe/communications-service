import {getDatabase} from './database.js';
import {tenantDatabase} from './tenantContext.js';
import {check} from './operationalIntelligence.js';
import {createSession,presentSession,session,advance,respond,addAction} from './reviewEngine.js';

// Explicit tenant policy opt-in. A general caller must never obtain an owner's review.
export async function reviewVoice(args,context){
    if(!context.tenantId||!context.personId)throw new Error('A configured review identity is required');
    const raw=getDatabase();if(!raw)throw new Error('Review persistence unavailable');
    const db=tenantDatabase(raw,context.tenantId);
    const tenant=check(await db.from('tenants').select('metadata').eq('tenant_id',context.tenantId).maybeSingle());
    const policy=tenant?.metadata?.promise_ledger;
    if(policy?.voice_review_enabled!==true||policy.local_person_id!==context.personId)throw new Error('Voice review is not enabled for this caller');
    const owner=`voice:${context.personId}`;
    // Caller supplied arguments cannot widen the server's configured project scope.
    const scope={person_id:context.personId,...(Array.isArray(policy.project_ids)?{allowed_project_ids:policy.project_ids}:{})};
    if(args.operation==='start')return presentSession(await createSession(db,scope,owner));
    if(args.operation==='read')return presentSession(await session(db,args.session_id,owner,scope));
    if(args.operation==='advance')return advance(db,args.session_id,args,owner,scope);
    if(args.operation==='respond')return respond(db,args.session_id,args,owner,scope);
    if(args.operation==='action')return addAction(db,args.session_id,args,owner,scope);
    throw new Error('Unknown review operation');
}
export const reviewVoiceTool={type:'builtin',timeoutMs:15000,
    description:'Conduct an explicitly enabled owner review. Start by presenting the briefing, then advance to review questions one at a time. Read the returned question and wait for the human answer. Respond with ACCEPT or REJECT only when the human clearly confirms or rejects that specific proposal; otherwise ask for clarification or DEFER. Always include their original utterance, current expected_revision, review_item_id and a unique request_id. On NEXT_ACTIONS explicitly ask for new instructions and queue them using action. Queued instructions are not completed actions. Advance to SUMMARY, read the result, then advance to COMPLETED and use end_call when the human is ready. Read the session after a timeout before retrying; reuse the request_id for retries.',
    parameters:{type:'object',properties:{operation:{type:'string',enum:['start','read','advance','respond','action']},session_id:{type:'string'},expected_revision:{type:'integer'},review_item_id:{type:'string'},request_id:{type:'string'},utterance:{type:'string'},intent:{type:'string',enum:['ACCEPT','REJECT','DEFER']},instruction:{type:'string'}},required:['operation']},handler:reviewVoice};
