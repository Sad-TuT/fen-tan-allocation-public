import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

// This integration test loads the production Node adapter, SQLite database,
// filesystem bucket, and actual persistence functions. All data is synthetic.
registerHooks({resolve(specifier:string,context:any,next:any){
 if(specifier==='server-only')return {url:'data:text/javascript,export default {}',shortCircuit:true};
 if(context.parentURL?.includes('/app/lib/') && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier))
  return next(new URL(specifier+'.ts',context.parentURL).href,context);
 return next(specifier,context);
}});
const testRoot=path.resolve('work-runtime-tests');
await mkdir(testRoot,{recursive:true});
const dataRoot=await mkdtemp(path.join(testRoot,'persistence-'));
process.env.ALLOCATION_DATA_DIR=dataRoot;
const persistence=await import(new URL('../app/lib/persistence.ts',import.meta.url).href);
const {CORE_REVIEW_CHECKS}=await import(new URL('../app/lib/review-policy.ts',import.meta.url).href);
const sourceId='synthetic-source';
const financials={totalCents:40000,quantity:20,sourceUsed:{[sourceId]:40000},sourceRemaining:{[sourceId]:32000}};
const asHash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
let nextId=0;
async function stage(version:number){
 const id=`node-financial-${++nextId}`, manifest=[];
 for(let n=0;n<4;n++){
  const bytes=new TextEncoder().encode(`synthetic workbook ${id} ${n}`);
  const key=`results/${id}/${n}.xlsx`;
  await persistence.storeFile(key,bytes,'application/octet-stream');
  manifest.push({key,name:`${n}.xlsx`,role:`result-${n}`,sha256:asHash(bytes)});
 }
 const nextState={sources:[`after-${id}`],taxes:[],productHistory:[{batchId:id}]};
 const batch={id,product:'合成商品',createdAt:new Date().toISOString(),createdBy:'synthetic',versionAtCreation:version,status:'awaiting_review',data:{reviewDigest:'a'.repeat(64),expectedFinancials:financials,manifest,nextState}};
 await persistence.createBatch(batch);
 return batch;
}
function report(id:string){return {reviewerId:`agent-${id}`,reviewerRunId:`run-${id}`,origin:'codex_subagent',status:'passed',reviewDigest:'a'.repeat(64),financials,checks:[...CORE_REVIEW_CHECKS],issues:[],unverified:[]};}

test('real Node storage: reviewed batch only posts once and rejects mutations and stale balances',async()=>{
 await persistence.saveWorkspace(0,{sources:['before'],taxes:[],productHistory:[]},'synthetic');
 const batch=await stage(1);
 await persistence.submitReview(batch.id,report('one'),'agent-one');
 await assert.rejects(persistence.commitBatch(batch.id,batch.data.nextState,'synthetic'),/两名/);
 assert.equal((await persistence.loadWorkspace()).version,1);
 await persistence.submitReview(batch.id,report('two'),'agent-two');
 const filePath=path.join(dataRoot,'objects',...batch.data.manifest[0].key.split('/'));
 const original=await readFile(filePath);const tampered=Buffer.from(original);tampered[tampered.length-1]^=1;
 await writeFile(filePath,tampered);
 await assert.rejects(persistence.commitBatch(batch.id,batch.data.nextState,'synthetic'),/文件缺失或已改变/);
 assert.equal((await persistence.loadWorkspace()).version,1);
 await writeFile(filePath,original);
 const completed=await persistence.commitBatch(batch.id,batch.data.nextState,'synthetic');
 assert.equal(completed.status,'completed');
 assert.deepEqual(await persistence.loadWorkspace(),{version:2,state:batch.data.nextState});
 await persistence.commitBatch(batch.id,batch.data.nextState,'synthetic');
 assert.equal((await persistence.loadWorkspace()).version,2);
 const stale=await stage(2);
 await persistence.submitReview(stale.id,report('three'),'agent-three');
 await persistence.submitReview(stale.id,report('four'),'agent-four');
 const newer={sources:['newer'],taxes:[],productHistory:[]};
 await persistence.saveWorkspace(2,newer,'synthetic');
 await assert.rejects(persistence.commitBatch(stale.id,stale.data.nextState,'synthetic'),/余额.*更新/);
 assert.deepEqual(await persistence.loadWorkspace(),{version:3,state:newer});
 assert.equal((await persistence.getBatch(stale.id))?.status,'awaiting_review');
});
