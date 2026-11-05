import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';

const reviewBytes=new TextEncoder().encode('blind-review-result');
const reviewSha=createHash('sha256').update(reviewBytes).digest('hex');
(globalThis as any).__reviewBundleBatch={
  id:'batch-blind',
  product:'盲审测试',
  status:'awaiting_review',
  createdBy:'operator',
  versionAtCreation:3,
  data:{
    reviewDigest:'d'.repeat(64),
    expectedFinancials:{shouldNeverEscape:true},
    snapshot:{version:3,state:{sources:[]},template:{key:'batches/template.xlsx',sha256:'a'.repeat(64)}},
    manifest:[{key:'batches/result.xlsx',name:'result.xlsx',sha256:reviewSha,role:'invoice'}],
  },
};
(globalThis as any).__reviewBundleReviews=[
  {reviewerId:'codex-reviewer-a',reviewerRunId:'run-a',submittedBy:'codex-reviewer-a',status:'passed',financials:{secretA:1}},
];

registerHooks({resolve(specifier:string,context:any,next:any){
  if(context.parentURL?.endsWith('/app/lib/workflow.ts')&&specifier==='./persistence'){
    return {url:'data:text/javascript,'+encodeURIComponent(`
      export async function loadWorkspace(){return {version:0,state:{sources:[],productHistory:[]}}}
      export async function saveWorkspace(){}
      export async function createBatch(){}
      export async function getBatch(){return globalThis.__reviewBundleBatch}
      export async function listBatches(){return []}
      export async function storeFile(){}
      export async function readFile(){return {bytes:new TextEncoder().encode('blind-review-result'),contentType:'application/octet-stream'}}
      export async function getReviews(){return globalThis.__reviewBundleReviews}
      export async function submitReview(){}
      export async function commitBatch(){}
    `),shortCircuit:true};
  }
  if(context.parentURL?.includes('/app/lib/')&&specifier.startsWith('.')&&!/\.[cm]?[jt]sx?$/.test(specifier)){
    return next(new URL(specifier+'.ts',context.parentURL).href,context);
  }
  return next(specifier,context);
}});

const workflow=await import(new URL('../app/lib/workflow.ts',import.meta.url).href);

test('review bundle omits expected financial answers and other reviewers reports',async()=>{
  const reviewerB=await workflow.reviewBundle('batch-blind','codex-reviewer-b');
  assert.equal('expectedFinancials' in reviewerB,false);
  assert.equal('reviews' in reviewerB,false);
  assert.deepEqual(reviewerB.reviewStatus,{submitted:false,status:null});

  const reviewerA=await workflow.reviewBundle('batch-blind','codex-reviewer-a');
  assert.equal('expectedFinancials' in reviewerA,false);
  assert.equal('reviews' in reviewerA,false);
  assert.deepEqual(reviewerA.reviewStatus,{submitted:true,status:'passed'});
  assert.equal(JSON.stringify(reviewerA).includes('secretA'),false);
});

test('download package is blind and cannot reveal expected results or prior reports',async()=>{
  const downloaded=await workflow.batchZip('batch-blind');
  const zip=await JSZip.loadAsync(downloaded.bytes);
  const names=Object.keys(zip.files);
  assert.equal(names.some((name)=>name.includes('/agent-')),false);
  const info=JSON.parse(await zip.file('待核验_undefined/运行记录/批次信息.json')!.async('string'));
  assert.equal('expectedFinancials' in info,false);
  assert.equal('reviews' in info,false);
  const bundle=JSON.parse(await zip.file('待核验_undefined/运行记录/核验请求.json')!.async('string'));
  assert.equal('expectedFinancials' in bundle,false);
  assert.equal('reviews' in bundle,false);
  assert.equal(JSON.stringify(bundle).includes('secretA'),false);
});
