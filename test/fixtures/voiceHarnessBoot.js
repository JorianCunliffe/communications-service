import {register} from 'node:module';
const realtime=process.env.VOICE_HARNESS_REALTIME,hyperflow=process.env.HYPERFLOW_EVENT_URL;
if(process.env.NODE_ENV!=='test'||process.env.OPENAI_API_KEY!=='test-no-provider-access'||new URL(realtime).hostname!=='127.0.0.1'||new URL(hyperflow).hostname!=='127.0.0.1')throw new Error('Only isolated loopback harnesses are allowed');
register('./voiceHarnessLoader.js',import.meta.url,{data:{realtime,hyperflow:new URL(hyperflow).origin}});
const {DEFAULT_CONFIG}=await import('../../config.js');
const {storeCallConfig}=await import('../../configResolver.js');
const {withBriefing}=await import('../../briefingVoice.js');
const context=JSON.parse(process.env.VOICE_HARNESS_CONTEXT);
storeCallConfig(process.env.VOICE_HARNESS_CALL_SID,{...withBriefing({...DEFAULT_CONFIG,...context},{type:'coaching_session'},true),aiSpeaksFirst:false,liveTranscript:true,maxCallSeconds:120});
