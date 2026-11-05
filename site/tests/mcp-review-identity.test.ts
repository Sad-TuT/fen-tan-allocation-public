import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project=fileURLToPath(new URL('../',import.meta.url));
const work=path.join(project,'work','mcp-review-identity');
await mkdir(work,{recursive:true});
const base=await mkdtemp(path.join(work,'case-'));
const tokenA='a'.repeat(64),tokenB='b'.repeat(64),tokenCommit='c'.repeat(64);
const tokenAFile=path.join(base,'reviewer-a-token');
const tokenBFile=path.join(base,'reviewer-b-token');
const commitFile=path.join(base,'commit-token');
await Promise.all([
  writeFile(tokenAFile,tokenA,{mode:0o600}),
  writeFile(tokenBFile,tokenB,{mode:0o600}),
  writeFile(commitFile,tokenCommit,{mode:0o600}),
]);
process.env.ALLOCATION_REVIEWER_A_TOKEN_FILE=tokenAFile;
process.env.ALLOCATION_REVIEWER_B_TOKEN_FILE=tokenBFile;
process.env.ALLOCATION_COMMIT_TOKEN_FILE=commitFile;

const files=new Map<string,Uint8Array>();
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const resultBytes=new TextEncoder().encode('result');
const templateBytes=new TextEncoder().encode('template');
const taxBytes=new TextEncoder().encode('tax');
const overrideBytes=new TextEncoder().encode('{"entities":{}}');
files.set('batches/b/result.xlsx',resultBytes);
files.set('batches/b/inputs/template.xlsx',templateBytes);
files.set('taxes/tax.xlsx',taxBytes);
files.set('tax-overrides/override.json',overrideBytes);

(globalThis as any).__mcpReviewCalls=[];
(globalThis as any).__mcpBatch={
  id:'b',data:{
    manifest:[{key:'batches/b/result.xlsx',sha256:hash(resultBytes)}],
    snapshot:{
      state:{sources:[],taxFile:{key:'taxes/tax.xlsx',sha256:hash(taxBytes)},taxOverrideFile:{key:'tax-overrides/override.json',sha256:hash(overrideBytes)}},
      template:{key:'batches/b/inputs/template.xlsx',sha256:hash(templateBytes)},
    },
  },
};
registerHooks({resolve(specifier:string,context:any,next:any){
  if(context.parentURL?.endsWith('/app/mcp/route.ts')&&specifier==='../lib/workflow')return {url:'data:text/javascript,'+encodeURIComponent(`
    export async function listBatches(){return []}
    export async function getBatch(id){return globalThis.__mcpBatch}
    export async function reviewBundle(id,actor){globalThis.__mcpReviewCalls.push({kind:'bundle',id,actor});return {batchId:id,reviewStatus:{submitted:false,status:null}}}
    export async function submitReview(id,report,actor){globalThis.__mcpReviewCalls.push({kind:'submit',id,report,actor});return undefined}
    export async function finalize(id,actor){globalThis.__mcpReviewCalls.push({kind:'commit',id,actor});return {id,status:'completed'}}
  `),shortCircuit:true};
  if(context.parentURL?.endsWith('/app/mcp/route.ts')&&specifier==='../lib/persistence')return {url:'data:text/javascript,'+encodeURIComponent(`
    export async function readFile(key){
      const value=globalThis.__mcpFiles.get(key);
      return value?{bytes:value,contentType:'application/octet-stream'}:null;
    }
  `),shortCircuit:true};
  if(context.parentURL?.includes('/app/')&&specifier.startsWith('.')&&!/\.[cm]?[jt]sx?$/.test(specifier))
    return next(new URL(specifier+'.ts',context.parentURL).href,context);
  return next(specifier,context);
}});
(globalThis as any).__mcpFiles=files;
const route=await import(new URL('../app/mcp/route.ts',import.meta.url).href);

function call(token:string|undefined,name:string,args:Record<string,unknown>){
  const headers=new Headers({host:'127.0.0.1:3038','content-type':'application/json'});
  if(token)headers.set('authorization',`Bearer ${token}`);
  return route.POST(new Request('http://127.0.0.1:3038/mcp',{
    method:'POST',headers,body:JSON.stringify({
      jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args},
    }),
  }));
}
async function payload(response:Response){return response.json() as Promise<any>;}
function report(reviewerId:string){
  return {
    reviewerId,reviewerRunId:`run-${reviewerId}`,origin:'codex_subagent',status:'passed',
    reviewDigest:'d'.repeat(64),financials:{},checks:[],issues:[],unverified:[],
  };
}

test('separate reviewer and commit credentials are bound to the reported identity',async()=>{
  assert.equal((await call(undefined,'allocation_list_batches',{})).status,403);
  const bundle=await payload(await call(tokenB,'allocation_review_bundle',{batchId:'b'}));
  assert.deepEqual(JSON.parse(bundle.result.content[0].text).reviewStatus,{submitted:false,status:null});
  const submittedA=await payload(await call(tokenA,'allocation_submit_review',{batchId:'b',report:report('codex-reviewer-a')}));
  assert.equal(submittedA.result.content[0].text.includes('codex-reviewer-a'),true);
  const submittedB=await payload(await call(tokenB,'allocation_submit_review',{batchId:'b',report:report('codex-reviewer-b')}));
  assert.equal(submittedB.result.content[0].text.includes('codex-reviewer-b'),true);
  const calls=(globalThis as any).__mcpReviewCalls;
  assert.deepEqual(calls.map((item:any)=>[item.kind,item.actor]),[
    ['bundle','codex-reviewer-b'],['submit','codex-reviewer-a'],['submit','codex-reviewer-b'],
  ]);
  const reviewerCommit=await payload(await call(tokenA,'allocation_commit_batch',{batchId:'b'}));
  assert.match(reviewerCommit.result.content[0].text,/复核凭据不能/);
  const controlledCommit=await payload(await call(tokenCommit,'allocation_commit_batch',{batchId:'b'}));
  assert.equal(controlledCommit.result.isError,undefined);
  assert.deepEqual(calls.at(-1),{kind:'commit',id:'b',actor:'allocation-commit-controller'});
});

test('review file access includes tax overrides and verifies the registered digest',async()=>{
  const allowed=await payload(await call(tokenA,'allocation_read_file',{batchId:'b',key:'tax-overrides/override.json'}));
  const value=JSON.parse(allowed.result.content[0].text);
  assert.equal(value.sha256,hash(overrideBytes));
  assert.equal(Buffer.from(value.base64,'base64').toString(),'{"entities":{}}');
  const unknown=await payload(await call(tokenA,'allocation_read_file',{batchId:'b',key:'tax-overrides/not-registered.json'}));
  assert.match(unknown.result.content[0].text,/不属于该批/);
  files.set('tax-overrides/override.json',new TextEncoder().encode('tampered'));
  const tampered=await payload(await call(tokenA,'allocation_read_file',{batchId:'b',key:'tax-overrides/override.json'}));
  assert.match(tampered.result.content[0].text,/SHA-256/);
});
