import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOutboundReady, dispatchTwilio } from '../outboundReadiness.js';
import { reserveOutbound } from '../outboundOperations.js';
const models = { read: () => ({ stale: false, checkedAt: 'now', models: [ { roles: ['voice'], usable: true }, { roles: ['live_transcription'], usable: true } ] }) };
const healthy = { probeTwilio: async () => ({ status: 'active', accountStatus: 'active', balanceState: 'ok' }), modelHealth: models };
const input = { tenantId: 'tenant', key: 'same-key', type: 'voice', request: { to: '+61400000000' }, communicationId: 'comm' };
function dbFixture(existing = null) {
 const state = { existing, reservations: 0 };
 const chain = { select() {return this;}, eq() {return this;}, async maybeSingle() { return {data: state.existing}; } };
 return { state, from: () => chain, rpc: async () => { state.reservations++; return { data: state.existing ? {...state.existing, claimed: false} : { id: 'op', status: 'reserved', claimed: true } }; } };
}
test('suspension, depleted balance and unknown health fail before reservation or dispatch', async () => {
 for (const status of ['suspended', 'closed', 'timeout', 'depleted_balance', 'balance_unavailable']) {
  const db = dbFixture();
  await assert.rejects(reserveOutbound(db, input, args => assertOutboundReady(args, { ...healthy, probeTwilio: async () => ({status,accountStatus:status,balanceState:'unknown'}) })), e => e.code === 'OUTBOUND_NOT_READY' && e.dispatched === false);
  assert.equal(db.state.reservations, 0);
 }
});
test('voice model outage blocks dispatch while low positive Twilio balance is a warning', async () => {
 await assertOutboundReady(input, {...healthy,probeTwilio:async()=>({accountStatus:'active',balanceState:'low'})});
 await assert.rejects(assertOutboundReady(input, {...healthy, modelHealth: {read:()=>({checkedAt:'now',stale:false,models:[{roles:['voice'],usable:false}]})}}), e=>e.code==='OUTBOUND_NOT_READY');
});
test('fresh checks are performed before each new reservation; existing receipts bypass provider health', async () => {
 let probes=0; const ready=async()=>{probes++;};
 await reserveOutbound(dbFixture(),input,ready); await reserveOutbound(dbFixture(),input,ready); assert.equal(probes,2);
 for(const status of ['completed','provider_sent']) { const result=await reserveOutbound(dbFixture({status,id:'op'}),input,ready); assert.equal(result.status,status); }
 assert.equal(probes,2);
});
test('young reservations defer and stale or invalid age requires reconciliation without dispatch', async () => {
 for(const [created_at,code] of [[new Date().toISOString(),'IDEMPOTENCY_IN_PROGRESS'],['2020-01-01','IDEMPOTENCY_RECONCILIATION_REQUIRED'],[null,'IDEMPOTENCY_RECONCILIATION_REQUIRED']]) {
  await assert.rejects(reserveOutbound(dbFixture({id:'op',status:'reserved',created_at}),input,()=>assert.fail('must not probe')),e=>e.code===code);
 }
});
test('Twilio rejection is persisted and repeated request cannot create another call', async () => {
 let calls=0, recorded;
 await assert.rejects(dispatchTwilio({}, {id:'op'},async()=>{calls++;throw {status:400,code:10001};},async(_db,id,row)=>{recorded={id,...row};}),e=>e.code==='OUTBOUND_PROVIDER_REJECTED'&&e.dispatched===false);
 assert.equal(recorded.status,'failed'); assert.equal(recorded.response.provider_code,10001);
 await assert.rejects(reserveOutbound(dbFixture(recorded),input,()=>assert.fail('must not probe')),e=>e.code==='OUTBOUND_PROVIDER_REJECTED');
 assert.equal(calls,1);
});
test('timeouts, network errors and server errors remain uncertain; never mark rejected',async()=>{
 for(const error of [new Error('timeout'),{status:503,code:20500},{status:408,code:20408}]) {
  await assert.rejects(dispatchTwilio({}, {id:'op'}, async()=>{throw error;},()=>assert.fail('must not clear reservation')),e=>e.code==='IDEMPOTENCY_RECONCILIATION_REQUIRED');
 }
});

test('lost rejection receipt remains uncertain rather than releasing the original key', async()=>{
 await assert.rejects(dispatchTwilio({}, {id:'op'}, async()=>{throw {status:400,code:10001};},async()=>{throw new Error('DB unavailable');}),e=>e.code==='IDEMPOTENCY_RECONCILIATION_REQUIRED');
});

test('preflight uses effective configured voice model without changing the frozen provider request',async()=>{
 let selected;
 await reserveOutbound(dbFixture(),{...input,readinessModel:'contact-model'},async ({request})=>{selected=request.overrides.model;});
 assert.equal(selected,'contact-model'); assert.equal(input.request.overrides,undefined);
});
