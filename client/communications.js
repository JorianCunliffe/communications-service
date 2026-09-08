/** Standalone Communications client; tenant is fixed and uncertain operations are never retried automatically. */
export class CommunicationsApiError extends Error {constructor(status,message){super(message);this.status=status;}}
export class CommunicationsClient {
  #apiKey;
  constructor(baseUrl,{apiKey,tenantId,fetcher=fetch}){
    this.base=new URL(baseUrl);
    if(!(this.base.protocol==='https:'||(this.base.protocol==='http:'&&['localhost','127.0.0.1'].includes(this.base.hostname)))||this.base.username||this.base.password||this.base.search||this.base.hash)throw new Error('Use an HTTPS Communications origin');
    if(!tenantId||!apiKey)throw new Error('A fixed tenant and API credential are required');
    this.#apiKey=apiKey;this.tenantId=tenantId;this.fetcher=fetcher;
  }
  async request(method,path,{query={},body,signal,idempotencyKey}={}){
    if(!/^\/(?:v1|api)\//.test(path)||/[?#]/.test(path))throw new Error('Use a relative Communications resource');
    const url=new URL(path,this.base);if(url.origin!==this.base.origin||!/^\/(?:v1|api)\//.test(url.pathname))throw new Error('Use a relative Communications resource');
    for(const[k,v]of Object.entries(query))url.searchParams.set(k,String(v));
    const response=await this.fetcher(url,{method,headers:{'X-API-Key':this.#apiKey,'X-Tenant-Id':this.tenantId,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:body!==undefined?JSON.stringify(body):undefined,signal,redirect:'error'});
    const value=await response.json();if(!response.ok)throw new CommunicationsApiError(response.status,value.error||'Communications request failed');return value;
  }
  clients(after=''){return this.request('GET','/v1/tenant/clients',{query:{after}});}
  clientOperation(body){return this.request('POST','/v1/tenant/clients',{body});}
  usage(){return this.request('GET','/v1/tenant/usage');}
  setBudget(revision,dailyLimit){return this.request('POST','/v1/tenant/usage',{body:{revision,dailyLimit}});}
  audit(offset=0){return this.request('GET','/v1/tenant/audit',{query:{offset}});}
  memory(body){return this.request('POST','/v1/context/memory',{body});}
}
