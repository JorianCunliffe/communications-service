import { createHash } from 'node:crypto';
import { rankThreadCandidates, resolveCommunicationThread } from './communicationModel.js';

/** A phone call is a new provider session, not necessarily a new conversation.
 * Without an utterance, only a single recent non-Ask candidate is safe to reuse.
 * Ambiguous calls keep a separate thread and ask for project/topic clarification.
 */
export async function resolveInboundVoiceThread({ db, tenantId, personId, from, to, communicationId, now = new Date().toISOString() }) {
    if (!db || !tenantId || !personId) throw new Error('Inbound conversation identity is unavailable');
    const existing = await db.from('communications').select('thread_id').eq('tenant_id',tenantId).eq('communication_id',communicationId).maybeSingle();
    if(existing.error)throw new Error('Existing call context lookup failed');
    const candidates = await rankThreadCandidates({ db, tenantId, participantIdentity: from,
        participantIdentities: [from], personIds: [personId], channel: 'voice', occurredAt: now });
    const eligible = candidates.filter(candidate => !candidate.excluded && candidate.score >= 65
        && [undefined,null,'triage','agent_conversation'].includes(candidate.thread?.purpose?.type)
        && Date.parse(now) - Date.parse(candidate.thread?.last_activity_at || '') <= 72 * 3600000);
    const selected = eligible.length === 1 ? eligible[0].thread : null;
    return resolveCommunicationThread({db,tenantId,personId,participantIdentity:from,serviceIdentity:to,
        direction:'inbound',channel:'voice',occurredAt:now,communicationId,
        threadId:existing.data?.thread_id || selected?.thread_id || `thread_${createHash('sha256').update(`${tenantId}:${communicationId}`).digest('hex').slice(0,32)}`,
        purpose:{type:'agent_conversation'},
        correlation:{tenant_id:tenantId,person_id:personId,run_id:`inbound:${communicationId}`,task_id:'inbound_conversation'},
    });
}
