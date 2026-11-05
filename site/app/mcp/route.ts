import { readFile as readSecretFile, lstat } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { reviewBundle,listBatches,getBatch,submitReview,finalize } from '../lib/workflow';
import { readFile } from '../lib/persistence';
import {isLocalReviewRequest} from '../lib/request-security';
export const dynamic='force-dynamic';
const tools=[
 {name:'allocation_list_batches',description:'列出分摊批次、状态、双审人数和是否余额过期。',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'allocation_review_bundle',description:'取得指定批次原始输入、规则、最终文件清单及哈希。需由两名独立子agent分别从原始资料和最终文件核算，不预设通过。',inputSchema:{type:'object',properties:{batchId:{type:'string'}},required:['batchId']}},
 {name:'allocation_read_file',description:'读取核验资料包内的一个原始或最终文件，返回base64及通过资料清单核验的SHA256；只允许该批次资料中的文件键。',inputSchema:{type:'object',properties:{batchId:{type:'string'},key:{type:'string'}},required:['batchId','key']}},
 {name:'allocation_submit_review',description:'提交一名真实Codex子agent对最终文件的独立核验报告；不得伪造agent或检查结果。两位均通过且金额一致前不会入账。',inputSchema:{type:'object',properties:{batchId:{type:'string'},report:{type:'object',properties:{reviewerId:{type:'string'},reviewerRunId:{type:'string'},origin:{const:'codex_subagent'},status:{enum:['passed','failed']},reviewDigest:{type:'string'},financials:{type:'object'},checks:{type:'array',items:{type:'string'}},issues:{type:'array',items:{type:'string'}},unverified:{type:'array',items:{type:'string'}}},required:['reviewerId','reviewerRunId','origin','status','reviewDigest','financials','checks','issues','unverified']}},required:['batchId','report']}},
 {name:'allocation_commit_batch',description:'在两份独立报告均有效、最终文件未变且余额版本一致后正式入账；同批重试不会重复扣减。',inputSchema:{type:'object',properties:{batchId:{type:'string'}},required:['batchId']}}
];
type Principal={id:string;kind:'reviewer'|'commit'};
async function readToken(pathname:string|undefined):Promise<string|null>{
 if(!pathname||!path.isAbsolute(pathname))return null;
 try{
  const stat=await lstat(pathname);
  if(!stat.isFile()||stat.isSymbolicLink()
    ||(process.platform!=='win32'&&((stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid())))
    ||stat.size>1024)return null;
  const secret=(await readSecretFile(pathname,'utf8')).trim();
  return /^[a-f0-9]{64,}$/i.test(secret)?secret:null;
 }catch{return null;}
}
async function principal(request:Request):Promise<Principal|null>{
 if(!isLocalReviewRequest(request))return null;
 const provided=request.headers.get('authorization')??'';
 if(!/^Bearer [a-f0-9]{64,}$/i.test(provided))return null;
 const entries:[Principal,string|undefined][]=[
  [{id:'codex-reviewer-a',kind:'reviewer'},process.env.ALLOCATION_REVIEWER_A_TOKEN_FILE],
  [{id:'codex-reviewer-b',kind:'reviewer'},process.env.ALLOCATION_REVIEWER_B_TOKEN_FILE],
  [{id:'allocation-commit-controller',kind:'commit'},process.env.ALLOCATION_COMMIT_TOKEN_FILE],
 ];
 let matched:Principal|null=null;
 for(const [identity,pathname] of entries){
  const secret=await readToken(pathname);
  const expected=secret?`Bearer ${secret}`:'';
  if(expected&&provided.length===expected.length&&timingSafeEqual(Buffer.from(provided),Buffer.from(expected))){
   if(matched)return null;
   matched=identity;
  }
 }
 return matched;
}
function sha256(bytes:Uint8Array):string{
 return createHash('sha256').update(bytes).digest('hex');
}
export async function POST(request:Request){if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return Response.json({error:'请求格式无效'},{status:415});const authenticated=await principal(request);if(!authenticated)return Response.json({error:'需要本机复核A、复核B或入账控制凭据'},{status:403});let id:any=null;try{const body=await request.json() as any;id=body.id;if(body.method==='server/discover')return Response.json({jsonrpc:'2.0',id,result:{supportedVersions:['2026-07-28'],capabilities:{tools:{}}}});if(body.method==='tools/list')return Response.json({jsonrpc:'2.0',id,result:{tools}});if(body.method?.startsWith('notifications/'))return new Response(null,{status:204});if(body.method!=='tools/call')throw new Error('Unsupported method');const a=body.params.arguments??{};let result:any;
 if(body.params.name==='allocation_list_batches')result=await listBatches();
 else if(body.params.name==='allocation_review_bundle')result=await reviewBundle(String(a.batchId),authenticated.id);
 else if(body.params.name==='allocation_submit_review'){
  if(authenticated.kind!=='reviewer')throw new Error('入账控制凭据不能提交复核报告');
  await submitReview(String(a.batchId),a.report,authenticated.id);result={saved:true,reviewerIdentity:authenticated.id};
 }
 else if(body.params.name==='allocation_commit_batch'){
  if(authenticated.kind!=='commit')throw new Error('复核凭据不能代替用户执行正式入账');
  result=await finalize(String(a.batchId),authenticated.id);
 }
 else if(body.params.name==='allocation_read_file'){
  const b=await getBatch(String(a.batchId));if(!b)throw new Error('批次不存在');
  const entries=[
   ...b.data.manifest.map((x:any)=>({key:x.key,sha256:x.sha256})),
   ...b.data.snapshot.state.sources.map((x:any)=>({key:x.fileKey,sha256:x.sha256})),
   {key:b.data.snapshot.template.key,sha256:b.data.snapshot.template.sha256},
   b.data.snapshot.state.taxFile&&{key:b.data.snapshot.state.taxFile.key,sha256:b.data.snapshot.state.taxFile.sha256},
   b.data.snapshot.state.taxOverrideFile&&{key:b.data.snapshot.state.taxOverrideFile.key,sha256:b.data.snapshot.state.taxOverrideFile.sha256},
  ].filter((entry:any)=>entry&&typeof entry.key==='string');
  const registered=entries.find((entry:any)=>entry.key===a.key);
  if(!registered)throw new Error('此文件不属于该批核验资料');
  const f=await readFile(a.key);if(!f)throw new Error('文件缺失');
  const actual=sha256(f.bytes);
  if(typeof registered.sha256!=='string'||actual!==registered.sha256.toLowerCase())throw new Error('文件SHA-256与批次清单不一致');
  result={key:a.key,base64:Buffer.from(f.bytes).toString('base64'),contentType:f.contentType,sha256:actual};
 }
 else throw new Error('未知工具');return Response.json({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}});
 }catch(e){return Response.json({jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:e instanceof Error?e.message:'工具调用失败'}]}});}}
