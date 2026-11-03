import { readFile as readSecretFile, lstat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { reviewBundle,listBatches,getBatch,submitReview,finalize } from '../lib/workflow';
import { readFile } from '../lib/persistence';
import {isLocalReviewRequest} from '../lib/request-security';
export const dynamic='force-dynamic';
const tools=[
 {name:'allocation_list_batches',description:'列出分摊批次、状态、双审人数和是否余额过期。',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'allocation_review_bundle',description:'取得指定批次原始输入、规则、最终文件清单及哈希。需由两名独立子agent分别从原始资料和最终文件核算，不预设通过。',inputSchema:{type:'object',properties:{batchId:{type:'string'}},required:['batchId']}},
 {name:'allocation_read_file',description:'读取核验资料包内的一个原始或最终Excel文件，返回base64及SHA256；只允许该批次资料中的文件键。',inputSchema:{type:'object',properties:{batchId:{type:'string'},key:{type:'string'}},required:['batchId','key']}},
 {name:'allocation_submit_review',description:'提交一名真实Codex子agent对最终文件的独立核验报告；不得伪造agent或检查结果。两位均通过且金额一致前不会入账。',inputSchema:{type:'object',properties:{batchId:{type:'string'},report:{type:'object',properties:{reviewerId:{type:'string'},reviewerRunId:{type:'string'},origin:{const:'codex_subagent'},status:{enum:['passed','failed']},reviewDigest:{type:'string'},financials:{type:'object'},checks:{type:'array',items:{type:'string'}},issues:{type:'array',items:{type:'string'}},unverified:{type:'array',items:{type:'string'}}},required:['reviewerId','reviewerRunId','origin','status','reviewDigest','financials','checks','issues','unverified']}},required:['batchId','report']}},
 {name:'allocation_commit_batch',description:'在两份独立报告均有效、最终文件未变且余额版本一致后正式入账；同批重试不会重复扣减。',inputSchema:{type:'object',properties:{batchId:{type:'string'}},required:['batchId']}}
];
async function reviewerAllowed(request:Request):Promise<boolean>{
 const file=process.env.ALLOCATION_REVIEW_TOKEN_FILE;
 if(!file||!file.startsWith('/')||!isLocalReviewRequest(request))return false;
 try{
  const stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid())||stat.size>1024)return false;
  const secret=(await readSecretFile(file,'utf8')).trim();
  const provided=request.headers.get('authorization')??'';
  if(!/^[a-f0-9]{64,}$/i.test(secret)||provided.length!==7+secret.length||!provided.startsWith('Bearer '))return false;
  return timingSafeEqual(Buffer.from(provided.slice(7)),Buffer.from(secret));
 }catch{return false;}
}
export async function POST(request:Request){if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return Response.json({error:'请求格式无效'},{status:415});if(!await reviewerAllowed(request))return Response.json({error:'需要本机核验凭据'},{status:403});const user={userId:'local-reviewer'};let id:any=null;try{const body=await request.json() as any;id=body.id;if(body.method==='server/discover')return Response.json({jsonrpc:'2.0',id,result:{supportedVersions:['2026-07-28'],capabilities:{tools:{}}}});if(body.method==='tools/list')return Response.json({jsonrpc:'2.0',id,result:{tools}});if(body.method?.startsWith('notifications/'))return new Response(null,{status:204});if(body.method!=='tools/call')throw new Error('Unsupported method');const a=body.params.arguments??{};let result:any;
 if(body.params.name==='allocation_list_batches')result=await listBatches();
 else if(body.params.name==='allocation_review_bundle')result=await reviewBundle(String(a.batchId));
 else if(body.params.name==='allocation_submit_review'){await submitReview(String(a.batchId),a.report,user.userId);result={saved:true};}
 else if(body.params.name==='allocation_commit_batch')result=await finalize(String(a.batchId),user.userId);
 else if(body.params.name==='allocation_read_file'){const b=await getBatch(String(a.batchId));if(!b)throw new Error('批次不存在');const keys=[...b.data.manifest.map((x:any)=>x.key),...b.data.snapshot.state.sources.map((x:any)=>x.fileKey),b.data.snapshot.template.key,b.data.snapshot.state.taxFile?.key];if(!keys.includes(a.key))throw new Error('此文件不属于该批核验资料');const f=await readFile(a.key);if(!f)throw new Error('文件缺失');result={key:a.key,base64:Buffer.from(f.bytes).toString('base64'),contentType:f.contentType};}
 else throw new Error('未知工具');return Response.json({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}});
 }catch(e){return Response.json({jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:e instanceof Error?e.message:'工具调用失败'}]}});}}
