import {createHash,randomUUID} from 'node:crypto';
import {hasCapability} from './auth.js';
import {TenantOperationError} from './tenantOperations.js';
export function redactExport(value){
 if(Array.isArray(value))return value.map(redactExport);
 if(!value||typeof value!=='object'){
  if(typeof value==='string'&&(/\/forms\/ask\/|\/api\/asks\//.test(value)||/[?&](token|key|signature|X-Goog-Signature|X-Amz-Signature)=/i.test(value)))return '[redacted capability URL]';
  return value;
 }
 return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/(secret|password|authorization|credential|api.?key|cookie|headers|signature|token)/i.test(key)?'[redacted]':redactExport(item)]));
}
const fail=(status,message)=>{throw new TenantOperationError(status,message);};
export async function tenantLifecycleOperation(db,request){
 if(!request.authContext?.roles?.includes('admin')||!hasCapability(request,'tenant:manage'))fail(403,'Tenant administrator capability required');
 const tenant=request.tenantId,q=request.query||{},b=request.body||{};
 const result=await db.from('tenants').select('tenant_id,status,lifecycle_revision').eq('tenant_id',tenant).maybeSingle();
 if(result.error)fail(503,'Tenant lifecycle unavailable');if(!result.data)fail(404,'Tenant not found');
 if(request.method==='POST'){
  if(!['suspend','resume','erase_local'].includes(b.operation)||!Number.isInteger(b.revision)||b.revision<1||!/^[a-zA-Z0-9_-]{8,100}$/.test(b.requestId||''))fail(422,'Operation, current revision and stable request identity required');
  if(b.operation==='erase_local'&&(!hasCapability(request,'tenant:erase')||b.confirmation!=='Erase Communications local tenant data'))fail(403,'Explicit tenant erasure capability and confirmation required');
  const changed=await db.rpc('tenant_data_lifecycle',{p_tenant_id:tenant,p_actor:request.authContext.keyId,p_request_id:b.requestId,p_operation:b.operation,p_revision:b.revision});
  if(changed.error)fail(['40001','55000'].includes(changed.error.code)?409:changed.error.code==='P0002'?404:503,changed.error.code==='55000'?'Lifecycle change requires review: '+changed.error.message:changed.error.code==='40001'?'Tenant version or request identity changed':'Tenant lifecycle unavailable');
  return changed.data;
 }
 if(request.method!=='GET')fail(405,'Method not allowed');
 if(q.dataset){
  if(!hasCapability(request,'memory:private'))fail(403,'Export requires authority to include private tenant evidence');
  const revision=Number(q.revision),offset=Number(q.offset||0);
  if(!Number.isInteger(revision)||!Number.isInteger(offset)||offset<0)fail(422,'Current suspended revision and export offset required');
  const page=await db.rpc('export_tenant_data_page',{p_tenant_id:tenant,p_revision:revision,p_dataset:String(q.dataset),p_offset:offset});
  if(page.error)fail(page.error.code==='42501'?403:page.error.code==='40001'?409:page.error.code==='54000'?413:503,'Export unavailable; use a current suspended revision and permitted dataset');
  page.data=redactExport(page.data);
  const hash=createHash('sha256').update(JSON.stringify(page.data)).digest('hex');
  const audit=await db.from('tenant_lifecycle_receipts').insert({tenant_id:tenant,request_id:randomUUID(),operation:'export',actor:request.authContext.keyId,revision,receipt:{dataset:q.dataset,offset,rows:page.data.rows.length,sha256:hash}});
  if(audit.error)fail(503,'Export audit unavailable');
  return {...page.data,sha256:hash};
 }
 const [datasets,receipts]=await Promise.all([db.from('tenant_data_sets').select('name,exportable').order('name',{ascending:true}),db.from('tenant_lifecycle_receipts').select('*').eq('tenant_id',tenant).order('created_at',{ascending:false}).limit(100)]);
 if(datasets.error||receipts.error)fail(503,'Lifecycle records unavailable');
 return {owner:'communications-service',tenant:result.data,datasets:datasets.data,receipts:receipts.data,scope:'Local Communications database only',externalCleanup:'Provider resources and HyperFlow records require their own receipts',retention:'Manual review; no automatic deletion policy enabled'};
}
