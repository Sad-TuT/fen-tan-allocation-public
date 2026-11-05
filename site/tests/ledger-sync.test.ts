import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import JSZip from 'jszip';

const execFileAsync=promisify(execFile);
const project=fileURLToPath(new URL('../',import.meta.url));
const script=path.join(project,'scripts','ledger-sync.mjs');
const work=path.join(project,'work','ledger-sync-tests');
const token='a'.repeat(64);
const sha256=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');

async function oldSnapshot(target:string,version=6){
  await mkdir(target,{recursive:true});
  const sourceBytes=new TextEncoder().encode(`old-source-${version}`);
  const sourceHash=sha256(sourceBytes);
  const summary={
    schemaVersion:1,workspaceVersion:version,
    sources:[{
      id:'old',priority:1,name:'旧来源',fileName:'旧来源.xlsx',file:'来源/第01来源.xlsx',sha256:sourceHash,
      originalCents:5000,availableCents:5000,usedCents:0,rowCount:1,history:[],rowsSha256:'b'.repeat(64),
    }],
    taxFiles:[],productHistory:[],instruction:'old',
  };
  const manifest={...summary,stateDigest:sha256(JSON.stringify(summary))};
  await mkdir(path.join(target,'来源'),{recursive:true});
  await writeFile(path.join(target,'来源','第01来源.xlsx'),sourceBytes,{mode:0o600});
  await writeFile(path.join(target,'账簿清单.json'),JSON.stringify(manifest),{mode:0o600});
  await writeFile(path.join(target,'old-marker.txt'),'keep-me',{mode:0o600});
}

async function fixture(
  working:string,
  options:{version?:number;digestOverride?:string;sourceHashOverride?:string;headerVersion?:string;base?:string}={},
  expectedToken=token,
){
  const version=options.version??7;
  const sourceBytes=new TextEncoder().encode(`source-version-${version}`);
  const sourceHash=sha256(sourceBytes);
  const summary={
    schemaVersion:1,workspaceVersion:version,exportedAt:'2026-11-05T00:00:00.000Z',
    sources:[{
      id:'first',priority:1,name:'第一来源',fileName:'第一来源.xlsx',file:'来源/第01来源.xlsx',
      sha256:options.sourceHashOverride??sourceHash,originalCents:100_00,availableCents:60_00,usedCents:40_00,rowCount:2,
      history:[{batchId:'old',product:'旧商品',usedCents:40_00}],rowsSha256:'a'.repeat(64),
    }],
    taxFiles:[],productHistory:[],instruction:'网站数据库是唯一正式账簿',
  };
  const stateDigest=options.digestOverride??sha256(JSON.stringify(summary));
  const manifest={...summary,stateDigest};
  const root=`网站账簿快照_v${version}`;
  const zip=new JSZip();
  zip.file(`${root}/来源/第01来源.xlsx`,sourceBytes);
  zip.file(`${root}/账簿清单.json`,JSON.stringify(manifest));
  const zipBytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  let seenAuthorization='';
  const server=createServer((request,response)=>{
    seenAuthorization=request.headers.authorization??'';
    if(request.url!=='/api/ledger/export'){response.writeHead(404).end();return;}
    if(seenAuthorization!==`Bearer ${expectedToken}`){response.writeHead(401).end('bad token');return;}
    response.writeHead(200,{
      'content-type':'application/zip',
      'content-length':String(zipBytes.length),
      'x-allocation-workspace-version':options.headerVersion??String(version),
      'x-allocation-ledger-sha256':stateDigest,
    });
    response.end(zipBytes);
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('test server did not expose a TCP port');

  const base=options.base??path.join(working,`case-${version}-${Math.random().toString(16).slice(2)}`);
  const target=path.join(base,'snapshot');
  const tokenFile=path.join(base,'token');
  const configFile=path.join(base,'sync.json');
  await mkdir(base,{recursive:true});
  await writeFile(tokenFile,token,{mode:0o600});
  await writeFile(configFile,JSON.stringify({
    schema_version:1,base_url:`http://127.0.0.1:${address.port}`,token_file:tokenFile,target_directory:target,
  }),{mode:0o600});
  return {
    target,configFile,base,server,
    close:async()=>{server.close();await once(server,'close');},
    getAuthorization:()=>seenAuthorization,
  };
}

async function runSync(configFile:string){
  try{
    const {stdout,stderr}=await execFileAsync(process.execPath,[script,'--config',configFile],{encoding:'utf8'});
    return {ok:true,stdout,stderr,result:JSON.parse(stdout) as any};
  }catch(error:any){
    return {ok:false,stdout:String(error.stdout??''),stderr:String(error.stderr??error.message??error),result:null};
  }
}

await mkdir(work,{recursive:true});

test('ledger sync verifies the manifest and atomically keeps the previous version',async()=>{
  const working=await mkdtemp(path.join(work,'success-'));
  const item=await fixture(working);
  try{
    await oldSnapshot(item.target);
    const run=await runSync(item.configFile);
    assert.equal(run.ok,true,run.stderr);
    assert.equal(run.result.workspaceVersion,7);
    assert.equal(run.result.sources[0].availableCents,6000);
    assert.equal(item.getAuthorization(),`Bearer ${token}`);
    assert.equal(await readFile(path.join(run.result.snapshotDirectory,'来源','第01来源.xlsx'),'utf8'),'source-version-7');
    const received=JSON.parse(await readFile(path.join(item.target,'同步接收记录.json'),'utf8'));
    assert.equal(received.workspace_version,7);
    assert.equal(received.source_available_cents,6000);
    assert.equal(await readFile(path.join(item.target,'old-marker.txt'),'utf8'),'keep-me');
  }finally{await item.close();}
});

test('an unchanged website ledger can be pulled repeatedly without replacing files',async()=>{
  const working=await mkdtemp(path.join(work,'unchanged-'));
  const item=await fixture(working);
  try{
    const first=await runSync(item.configFile);
    assert.equal(first.ok,true,first.stderr);
    const second=await runSync(item.configFile);
    assert.equal(second.ok,true,second.stderr);
    assert.equal(second.result.unchanged,true);
    assert.equal(second.result.snapshotDirectory,first.result.snapshotDirectory);
  }finally{await item.close();}
});

test('a newer ledger is published after the immutable version directory is complete',async()=>{
  const working=await mkdtemp(path.join(work,'new-version-'));
  const firstItem=await fixture(working,{version:7});
  const base=firstItem.base;
  try{
    const first=await runSync(firstItem.configFile);
    assert.equal(first.ok,true,first.stderr);
  }finally{await firstItem.close();}
  const secondItem=await fixture(working,{version:8,base});
  try{
    const second=await runSync(secondItem.configFile);
    assert.equal(second.ok,true,second.stderr);
    assert.equal(second.result.workspaceVersion,8);
    assert.notEqual(second.result.snapshotDirectory,firstItem.target);
    assert.equal(await readFile(path.join(second.result.snapshotDirectory,'来源','第01来源.xlsx'),'utf8'),'source-version-8');
    const active=JSON.parse(await readFile(path.join(secondItem.target,'账簿清单.json'),'utf8'));
    const receipt=JSON.parse(await readFile(path.join(secondItem.target,'同步接收记录.json'),'utf8'));
    assert.equal(active.workspaceVersion,8);
    assert.equal(receipt.workspace_version,8);
    assert.equal(receipt.snapshot_directory,path.relative(secondItem.target,second.result.snapshotDirectory));
  }finally{await secondItem.close();}
});

test('invalid bearer token is rejected without touching the existing snapshot',async()=>{
  const working=await mkdtemp(path.join(work,'auth-'));
  const item=await fixture(working,{},'b'.repeat(64));
  try{
    await oldSnapshot(item.target);
    const run=await runSync(item.configFile);
    assert.equal(run.ok,false);
    assert.match(run.stderr,/HTTP 401/);
    assert.equal(await readFile(path.join(item.target,'old-marker.txt'),'utf8'),'keep-me');
  }finally{await item.close();}
});

test('a failed first sync leaves no half-created target and can be retried',async()=>{
  const working=await mkdtemp(path.join(work,'retry-first-'));
  const failed=await fixture(working,{},'b'.repeat(64));
  const base=failed.base;
  try{
    const run=await runSync(failed.configFile);
    assert.equal(run.ok,false);
    assert.match(run.stderr,/HTTP 401/);
    await assert.rejects(stat(failed.target),{code:'ENOENT'});
  }finally{await failed.close();}
  const retried=await fixture(working,{base});
  try{
    const run=await runSync(retried.configFile);
    assert.equal(run.ok,true,run.stderr);
    assert.equal(run.result.workspaceVersion,7);
  }finally{await retried.close();}
});

test('a first-sync payload failure removes the newly created target root',async()=>{
  const working=await mkdtemp(path.join(work,'retry-first-payload-'));
  const item=await fixture(working,{sourceHashOverride:'0'.repeat(64)});
  try{
    const run=await runSync(item.configFile);
    assert.equal(run.ok,false);
    assert.match(run.stderr,/来源文件哈希不符/);
    await assert.rejects(stat(item.target),{code:'ENOENT'});
  }finally{await item.close();}
});

test('a concurrent local sync is blocked by an exclusive lock',async()=>{
  const working=await mkdtemp(path.join(work,'sync-lock-'));
  const item=await fixture(working);
  const lockPath=path.join(path.dirname(item.target),
    `.ledger-sync-${sha256(item.target.toLowerCase()).slice(0,16)}.lock`);
  await writeFile(lockPath,JSON.stringify({
    pid:process.pid,created_at:new Date().toISOString(),target:item.target,token:'held-by-test',
  }),{mode:0o600});
  try{
    const run=await runSync(item.configFile);
    assert.equal(run.ok,false);
    assert.match(run.stderr,/另一个账簿同步进程正在运行/);
    await assert.rejects(readFile(item.target));
  }finally{await item.close();}
});

test('source hash mismatch fails closed and preserves the previous snapshot',async()=>{
  const working=await mkdtemp(path.join(work,'tamper-'));
  const item=await fixture(working,{sourceHashOverride:'0'.repeat(64)});
  try{
    await oldSnapshot(item.target);
    const run=await runSync(item.configFile);
    assert.equal(run.ok,false);
    assert.match(run.stderr,/来源文件哈希不符/);
    assert.equal(await readFile(path.join(item.target,'old-marker.txt'),'utf8'),'keep-me');
  }finally{await item.close();}
});

test('download version header mismatch fails closed',async()=>{
  const working=await mkdtemp(path.join(work,'version-header-'));
  const item=await fixture(working,{headerVersion:'8'});
  try{
    await oldSnapshot(item.target);
    const run=await runSync(item.configFile);
    assert.equal(run.ok,false);
    assert.match(run.stderr,/下载版本与账簿清单不一致/);
    assert.equal(await readFile(path.join(item.target,'old-marker.txt'),'utf8'),'keep-me');
  }finally{await item.close();}
});

test('an older website version cannot roll back a newer local snapshot',async()=>{
  const working=await mkdtemp(path.join(work,'rollback-'));
  const item=await fixture(working,{version:5});
  try{
    await oldSnapshot(item.target,6);
    const run=await runSync(item.configFile);
    assert.equal(run.ok,false);
    assert.match(run.stderr,/拒绝回滚/);
    assert.equal(await readFile(path.join(item.target,'old-marker.txt'),'utf8'),'keep-me');
  }finally{await item.close();}
});

test('editing a current-version snapshot file is detected before replacement',async()=>{
  const working=await mkdtemp(path.join(work,'old-file-tamper-'));
  const item=await fixture(working);
  try{
    await oldSnapshot(item.target);
    await writeFile(path.join(item.target,'来源','第01来源.xlsx'),'tampered',{mode:0o600});
    const run=await runSync(item.configFile);
    assert.equal(run.ok,false);
    assert.match(run.stderr,/现有本地快照.*哈希不符/);
    assert.equal(await readFile(path.join(item.target,'来源','第01来源.xlsx'),'utf8'),'tampered');
  }finally{await item.close();}
});

test('editing a current-version manifest without updating its digest is rejected',async()=>{
  const working=await mkdtemp(path.join(work,'old-manifest-tamper-'));
  const item=await fixture(working);
  try{
    await oldSnapshot(item.target);
    const manifestPath=path.join(item.target,'账簿清单.json');
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    manifest.workspaceVersion=1;
    await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
    const run=await runSync(item.configFile);
    assert.equal(run.ok,false);
    assert.match(run.stderr,/现有本地快照.*内容与摘要不符/);
    assert.equal(JSON.parse(await readFile(manifestPath,'utf8')).workspaceVersion,1);
  }finally{await item.close();}
});

test('editing the manifest inside an immutable version directory is rejected',async()=>{
  const working=await mkdtemp(path.join(work,'inner-manifest-tamper-'));
  const item=await fixture(working);
  try{
    const first=await runSync(item.configFile);
    assert.equal(first.ok,true,first.stderr);
    const innerManifest=path.join(first.result.snapshotDirectory,'账簿清单.json');
    await chmod(innerManifest,0o600);
    await writeFile(innerManifest,'{}',{mode:0o600});
    const run=await runSync(item.configFile);
    assert.equal(run.ok,false);
    assert.match(run.stderr,/版本目录内的账簿清单与根清单不一致/);
  }finally{await item.close();}
});

test('an existing snapshot directory without a valid manifest is never overwritten',async()=>{
  const working=await mkdtemp(path.join(work,'corrupt-old-'));
  const item=await fixture(working);
  try{
    await mkdir(item.target,{recursive:true});
    await writeFile(path.join(item.target,'untrusted.txt'),'keep-me',{mode:0o600});
    const run=await runSync(item.configFile);
    assert.equal(run.ok,false);
    assert.match(run.stderr,/现有本地快照无法校验/);
    assert.equal(await readFile(path.join(item.target,'untrusted.txt'),'utf8'),'keep-me');
  }finally{await item.close();}
});
