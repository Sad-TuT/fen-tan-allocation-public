import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';

registerHooks({resolve(specifier:string,context:any,next:any){
  if(specifier==='server-only')return {url:'data:text/javascript,export default {}',shortCircuit:true};
  if(context.parentURL?.includes('/app/lib/') && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier))return next(new URL(specifier+'.ts',context.parentURL).href,context);
  return next(specifier,context);
}});
const root=path.resolve('work-runtime-tests');await mkdir(root,{recursive:true});
process.env.ALLOCATION_DATA_DIR=await mkdtemp(path.join(root,'blank-dept-'));
const persistence=await import(new URL('../app/lib/persistence.ts',import.meta.url).href);
const { finalize }=await import(new URL('../app/lib/workflow.ts',import.meta.url).href);
const { planAllocation }=await import(new URL('../app/lib/allocation.ts',import.meta.url).href);
const { CORE_REVIEW_CHECKS }=await import(new URL('../app/lib/review-policy.ts',import.meta.url).href);

const source:any={id:'s',name:'合成来源',priority:2,allowBlankDepartment:true,originalCents:3300,history:[],rows:[{id:'r',sourceId:'s',originalFile:'synthetic.xlsx',originalRow:4,applicant:'甲',department:'',useCenter:'中心',costCenter:'成本中心',legalEntity:'测试公司（L100001）',purpose:'用途',amountCents:3300}]};
const plan=planAllocation([source],3300,1);
const financials={totalCents:3300,quantity:1,sourceUsed:{s:3300},sourceRemaining:{s:0}};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function stage(id:string,version:number,snapshotSource:any,legacy=false){
  const manifest=[];
  for(let n=0;n<4;n++){const bytes=new TextEncoder().encode(`${id}-${n}`),key=`results/${id}/${n}.xlsx`;await persistence.storeFile(key,bytes,'application/octet-stream');manifest.push({key,name:`${n}.xlsx`,role:`result-${n}`,sha256:hash(bytes)});}
  const state={sources:[snapshotSource],taxes:[],productHistory:[]};
  const nextState={sources:[{...source,rows:[]}],taxes:[],productHistory:[{batchId:id,product:'测试商品'}]};
  const snapshot=legacy?{state}:{state,ruleVersion:plan.ruleVersion,departmentAssignments:plan.departmentAssignments,groupMembership:plan.groupMembership};
  const batch={id,product:'测试商品',createdAt:new Date().toISOString(),createdBy:'test',versionAtCreation:version,status:'awaiting_review',data:{reviewDigest:'a'.repeat(64),expectedFinancials:financials,manifest,nextState,plan,snapshot}};
  await persistence.createBatch(batch);
  for(const n of [1,2])await persistence.submitReview(id,{reviewerId:`agent-${n}`,reviewerRunId:`run-${n}`,origin:'codex_subagent',status:'passed',reviewDigest:'a'.repeat(64),financials,checks:[...CORE_REVIEW_CHECKS],issues:[],unverified:[]},`agent-${n}`);
  return batch;
}

test('old-rule batch remains blocked with two reviews; new compatible batch posts exactly once',async()=>{
  const state={sources:[source],taxes:[],productHistory:[]};await persistence.saveWorkspace(0,state,'test');
  const legacy=structuredClone(source);delete legacy.allowBlankDepartment;
  await stage('legacy',1,legacy,true);
  await assert.rejects(finalize('legacy','test'),/旧规则|当前规则核对未通过/);
  assert.deepEqual(await persistence.loadWorkspace(),{version:1,state});
  const valid=await stage('authorized',1,source);
  assert.equal((await finalize('authorized','test')).status,'completed');
  assert.deepEqual(await persistence.loadWorkspace(),{version:2,state:valid.data.nextState});
  await finalize('authorized','test');assert.equal((await persistence.loadWorkspace()).version,2);
});
