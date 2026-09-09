import { createHash } from 'node:crypto';
import { hashApiSecret, hasCapability } from './auth.js';

export class TenantOperationError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
const fail=(status,message)=>{throw new TenantOperationError(status,message);};
const columns='key_id,name,allowed_tenants,roles,capabilities,created_at,revoked_at,last_used_at,revision,expires_at';
const supported=new Set(['communications:read','communications:write','memory:private','email:draft','email:send','mailbox:manage','tenant:manage','tenant:erase']);
/** Lifecycle is restricted to credentials created for this one tenant. Legacy/multi-tenant operator keys are never exposed. */
export async function tenantClientOperation(db,request){
  if(!hasCapability(request,'tenant:manage') || !request.authContext?.roles?.includes('admin')) fail(403,'Tenant administrator capability required');
  const tenant=request.tenantId, b=request.body||{};
  if(request.method==='GET'){
    const after=String(request.query?.after||'');
    if(after && !/^[a-zA-Z0-9_-]{8,80}$/.test(after))fail(422,'Invalid client cursor');
    let query=db.from('api_clients').select(columns).eq('managed_tenant_id',tenant).order('key_id',{ascending:true}).limit(51);
    if(after)query=query.gt('key_id',after);
    const result=await query;
    if(result.error)fail(503,'Client registry is unavailable');
    const rows=result.data||[];
    return {owner:'communications-service',items:rows.slice(0,50),next:rows.length>50?rows[49].key_id:null};
  }
  if(request.method!=='POST')fail(405,'Method not allowed');
  if(!['create','rotate','revoke'].includes(b.operation) || !/^[a-zA-Z0-9_-]{8,80}$/.test(b.keyId||''))fail(422,'Choose a stable client identity and operation');
  if(b.operation!=='create' && (!Number.isInteger(b.revision)||b.revision<1))fail(422,'Current client revision required');
  if(b.operation==='revoke' && b.keyId===request.authContext.keyId)fail(409,'Use another administrator credential to revoke this client');
  const payload={};
  if(b.operation!=='revoke'){
    if(typeof b.secret!=='string'||b.secret.length<32||b.secret.length>256)fail(422,'Provide a new high-entropy secret of 32 to 256 characters');
    const expires=Date.parse(b.expiresAt);
    if(!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+366*86400000)fail(422,'Expiry must be within the next 366 days');
    payload.secret_hash=await hashApiSecret(b.secret);
    payload.expires_at=new Date(expires).toISOString();
    if(b.operation==='rotate')payload.rotation_hash=createHash('sha256').update(JSON.stringify([b.secret,payload.expires_at])).digest('hex');
  }
  if(b.operation==='create'){
    if(typeof b.name!=='string'||!b.name.trim()||b.name.length>120)fail(422,'Client name required');
    if(!Array.isArray(b.capabilities)||!b.capabilities.length||b.capabilities.length>supported.size||b.capabilities.some(c=>!supported.has(c)||!hasCapability(request,c)))fail(403,'Client capabilities must be a supported subset of your authority');
    if(!Array.isArray(b.roles)||b.roles.some(r=>!['admin','reader','writer'].includes(r)))fail(422,'Invalid client roles');
    payload.name=b.name.trim(); payload.roles=[...new Set(b.roles)].sort(); payload.capabilities=[...new Set(b.capabilities)].sort();
    // An original request can be replayed without storing or returning its plaintext secret.
    payload.request_hash=createHash('sha256').update(JSON.stringify([tenant,b.keyId,payload.name,payload.roles,payload.capabilities,payload.expires_at,b.secret])).digest('hex');
  }
  const result=await db.rpc('manage_tenant_api_client',{
    p_tenant_id:tenant,p_actor:request.authContext.keyId,p_operation:b.operation,p_key_id:b.keyId,
    p_expected_revision:b.revision||0,p_client:payload,
  });
  if(result.error)fail(result.error.code==='40001'?409:result.error.code==='P0002'?404:503,
    result.error.code==='40001'?'Client version or identity changed':result.error.code==='P0002'?'Managed client not found':'Client update unavailable');
  return {owner:'communications-service',item:result.data,secretReturned:false};
}
