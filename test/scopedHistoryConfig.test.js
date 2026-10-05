import test from 'node:test';
import assert from 'node:assert/strict';
import { personaliseConfig, SCOPED_HISTORY_NOTICE } from '../config.js';
import { applyHyperFlowVoiceContext } from '../hyperflowVoice.js';

test('inbound personalization withholds private history without inventing absence', () => {
  const config = {systemMessage:'Caller {{name}}. Prior contact: {{combined_history|No previous contact on record.}} {{history|Never spoken before}}',assistantName:'Reception'};
  const result = personaliseConfig(config,{name:'Jorian',combined_history:'PRIVATE UNRELATED HISTORY'},{scopedHistory:true});
  assert.match(result.systemMessage,/Jorian/);
  assert.ok(result.systemMessage.includes(SCOPED_HISTORY_NOTICE));
  assert.doesNotMatch(result.systemMessage,/PRIVATE UNRELATED HISTORY|No previous contact on record|Never spoken before/);
  assert.equal(result.wantsHistory,false);
  const routed = applyHyperFlowVoiceContext(result,{greeting:'Choose a project',instructions:'History not loaded until selection',routing:{kind:'clarification'}});
  assert.doesNotMatch(routed.systemMessage,/PRIVATE UNRELATED HISTORY|No previous contact on record/);
});
test('unknown inbound caller also does not imply absence of history; outbound compatibility remains', () => {
  const config = {systemMessage:'{{combined_history}} {{history}}'};
  assert.ok(personaliseConfig(config,null,{scopedHistory:true}).systemMessage.includes(SCOPED_HISTORY_NOTICE));
  assert.match(personaliseConfig(config,{combined_history:'Existing outbound summary'}).systemMessage,/Existing outbound summary/);
  assert.equal(personaliseConfig(config,null).wantsHistory,true);
});
