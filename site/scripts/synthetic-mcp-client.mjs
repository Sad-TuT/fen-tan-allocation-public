// Synthetic test helper. Refuses production port 3028 and remote hosts.
// Bearer secret is read from a file and never printed or accepted as an argument.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const endpoint=new URL(process.env.SYNTHETIC_MCP_URL||'http://localhost:3037/mcp');
if(endpoint.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)||endpoint.port==='3028'||!endpoint.port||endpoint.pathname!=='/mcp')throw new Error('Synthetic client requires a non-production loopback endpoint.');
const secretPath=process.env.SYNTHETIC_MCP_TOKEN_FILE;
if(!secretPath||!path.isAbsolute(secretPath))throw new Error('Set the absolute synthetic token file path.');
const token=(await readFile(secretPath,'utf8')).trim();
if(!/^[a-f0-9]{64,}$/i.test(token))throw new Error('Invalid token file.');
const [action,batchId,third,fourth]=process.argv.slice(2);
let name,args={};
if(action==='list')name='allocation_list_batches';
else if(action==='bundle'&&batchId){name='allocation_review_bundle';args={batchId};}
else if(action==='read'&&batchId&&third&&fourth){name='allocation_read_file';args={batchId,key:third};}
else if(action==='submit'&&batchId&&third){name='allocation_submit_review';args={batchId,report:JSON.parse(await readFile(third,'utf8'))};}
else if(action==='commit'&&batchId){name='allocation_commit_batch';args={batchId};}
else throw new Error('Usage: list | bundle BATCH | read BATCH KEY OUTPUT | submit BATCH REPORT | commit BATCH');
const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
const payload=await response.json();
if(!response.ok || payload.error || payload.result?.isError)throw new Error(`MCP request failed: ${JSON.stringify(payload.error||payload.result?.content||response.status)}`);
const value=JSON.parse(payload.result.content[0].text);
if(action==='read'){
 await writeFile(fourth,Buffer.from(value.base64,'base64'),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({saved:fourth,key:value.key,contentType:value.contentType}));
}else console.log(JSON.stringify(value,null,2));
