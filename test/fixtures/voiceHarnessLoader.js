// Test-process-only provider transport substitution. No production configuration switch.
let options;
export function initialize(data){options=data;}
export async function load(url,context,nextLoad){
  const result=await nextLoad(url,context);
  if(url.endsWith('/config.js')) return {...result,source:String(result.source).replace('wss://api.openai.com/v1/realtime?',options.realtime+'/realtime?')};
  if(url.endsWith('/safeFetch.js')) return {...result,source:String(result.source).replace('export async function safeFetch(','async function productionSafeFetch(')+`\nexport async function safeFetch(url,options){if(new URL(url).origin!==${JSON.stringify(options.hyperflow)})throw new Error('Harness refuses external network');return fetch(url,options);}\n`};
  return result;
}
