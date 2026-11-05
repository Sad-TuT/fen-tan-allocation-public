#!/usr/bin/env node
import {createHash,randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,open,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const MAX_DOWNLOAD_BYTES=100*1024*1024;
const MANIFEST_NAME='账簿清单.json';
const RECEIPT_NAME='同步接收记录.json';
const sha256=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const isDigest=(value)=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const assertDigest=(value,label)=>{
  if(!isDigest(value))throw new Error(`${label}不是有效的SHA-256摘要`);
  return value.toLowerCase();
};
const absolute=(value,label)=>{
  if(typeof value!=='string'||!path.isAbsolute(value))throw new Error(`${label}必须是绝对路径`);
  const resolved=path.resolve(value);
  if(resolved===path.parse(resolved).root)throw new Error(`${label}不能是磁盘根目录`);
  return resolved;
};
async function ordinaryDirectoryChain(directory,label){
  const resolved=path.resolve(directory),root=path.parse(resolved).root;
  let current=root;
  const parts=path.relative(root,resolved).split(path.sep).filter(Boolean);
  for(const part of parts){
    current=path.join(current,part);
    const info=await lstat(current).catch(error=>{if(error?.code==='ENOENT')throw new Error(`${label}缺失`);throw error;});
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error(`${label}的目录链不能包含符号链接或目录联接`);
  }
}
function argument(name){
  const index=process.argv.indexOf(name);
  return index>=0?process.argv[index+1]:undefined;
}
function parseManifest(bytes,label){
  let manifest;
  try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error(`${label}无法解码`);}
  if(manifest?.schemaVersion!==1||!Number.isSafeInteger(manifest?.workspaceVersion)||manifest.workspaceVersion<0)throw new Error(`${label}版本无效`);
  assertDigest(manifest.stateDigest,`${label}摘要`);
  const {stateDigest:declaredDigest,...digestPayload}=manifest;
  if(sha256(Buffer.from(JSON.stringify(digestPayload),'utf8'))!==declaredDigest.toLowerCase())throw new Error(`${label}内容与摘要不符`);
  return {manifest,digestPayload};
}
function snapshotDirectoryName(manifest){
  return `v${manifest.workspaceVersion}-${manifest.stateDigest.toLowerCase().slice(0,16)}`;
}
function safeRelative(value,kind){
  const pattern=kind==='source'
    ?/^来源\/第\d{2,}来源\.xlsx$/
    :/^资料\/(税务主体\.xlsx|税务修正\.json)$/;
  if(typeof value!=='string'||!pattern.test(value))throw new Error(kind==='source'?'账簿来源文件路径不受支持':'税务资料路径不受支持');
  return value;
}
async function regularFile(root,relative,label){
  const resolvedRoot=path.resolve(root);
  const rootInfo=await lstat(resolvedRoot).catch(error=>{if(error?.code==='ENOENT')throw new Error(`${label}根目录缺失`);throw error;});
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new Error(`${label}根目录不能是符号链接`);
  const parts=relative.split('/');
  let parent=resolvedRoot;
  for(const part of parts.slice(0,-1)){
    parent=path.join(parent,part);
    const info=await lstat(parent).catch(error=>{if(error?.code==='ENOENT')throw new Error(`${label}路径缺失`);throw error;});
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error(`${label}上级目录不能是符号链接`);
  }
  const destination=path.resolve(resolvedRoot,...parts);
  if(!destination.startsWith(resolvedRoot+path.sep))throw new Error(`${label}路径越出快照目录`);
  const info=await lstat(destination).catch(error=>{if(error?.code==='ENOENT')throw new Error(`${label}缺失`);throw error;});
  if(!info.isFile()||info.isSymbolicLink())throw new Error(`${label}必须是普通文件且不能是符号链接`);
  return {destination,bytes:new Uint8Array(await readFile(destination))};
}
async function verifySnapshotFiles(root,manifest,label){
  if(!Array.isArray(manifest.sources)||!manifest.sources.length)throw new Error(`${label}没有金额来源`);
  if(new Set(manifest.sources.map(source=>source.id)).size!==manifest.sources.length)throw new Error(`${label}来源编号重复`);
  if(new Set(manifest.sources.map(source=>source.priority)).size!==manifest.sources.length)throw new Error(`${label}来源优先级重复`);
  for(const source of manifest.sources){
    const relative=safeRelative(source.file,'source');
    const expected=assertDigest(source.sha256,`${label}来源“${source.name??source.id}”的文件摘要`);
    const file=await regularFile(root,relative,`${label}来源文件：${relative}`);
    if(sha256(file.bytes)!==expected)throw new Error(`${label}来源文件哈希不符：${source.name??source.id}`);
    if(!Number.isSafeInteger(source.priority)||source.priority<1)throw new Error(`${label}来源优先级无效：${source.name??source.id}`);
    const available=Number(source.availableCents),original=Number(source.originalCents),used=Number(source.usedCents);
    if(!Number.isSafeInteger(available)||!Number.isSafeInteger(original)||!Number.isSafeInteger(used)
      ||available<0||used<0||original!==available+used)throw new Error(`${label}账簿对账不平：${source.name??source.id}`);
  }
  if(!Array.isArray(manifest.taxFiles))throw new Error(`${label}税务文件清单无效`);
  if(new Set(manifest.taxFiles.map(item=>item.name)).size!==manifest.taxFiles.length)throw new Error(`${label}税务资料路径重复`);
  for(const item of manifest.taxFiles){
    const relative=safeRelative(item.name,'tax');
    const expected=assertDigest(item.sha256,`${label}税务资料“${relative}”的摘要`);
    const file=await regularFile(root,relative,`${label}税务资料：${relative}`);
    if(sha256(file.bytes)!==expected)throw new Error(`${label}税务资料哈希不符：${relative}`);
  }
}
async function loadExistingManifest(target){
  let exists=false;
  try{
    const targetInfo=await lstat(target);
    if(!targetInfo.isDirectory()||targetInfo.isSymbolicLink())throw new Error('现有快照路径不是普通目录');
    exists=true;
  }catch(error){if(error?.code!=='ENOENT')throw new Error(`现有本地快照无法校验，拒绝覆盖：${error instanceof Error?error.message:String(error)}`);}
  if(!exists)return null;
  try{
    const manifestPath=path.join(target,MANIFEST_NAME);
    const info=await lstat(manifestPath);
    if(!info.isFile()||info.isSymbolicLink())throw new Error('账簿清单必须是普通文件且不能是符号链接');
    const bytes=new Uint8Array(await readFile(manifestPath));
    const {manifest}=parseManifest(bytes,'现有快照清单');
    const versionsParent=path.join(target,'versions');
    const versionRoot=path.join(target,'versions',snapshotDirectoryName(manifest));
    let root=target;
    try{
      const versionsInfo=await lstat(versionsParent);
      if(!versionsInfo.isDirectory()||versionsInfo.isSymbolicLink())throw new Error('versions 目录不能是符号链接');
      const versionInfo=await lstat(versionRoot);
      if(!versionInfo.isDirectory()||versionInfo.isSymbolicLink())throw new Error('版本目录必须是普通目录且不能是符号链接');
      root=versionRoot;
    }
    catch(error){if(error?.code!=='ENOENT')throw error;}
    if(root!==target){
      const innerManifest=await regularFile(root,MANIFEST_NAME,'版本目录账簿清单');
      if(sha256(innerManifest.bytes)!==sha256(bytes))throw new Error('版本目录内的账簿清单与根清单不一致');
    }
    await verifySnapshotFiles(root,manifest,'现有快照');
    return {manifest,root};
  }catch(error){
    throw new Error(`现有本地快照无法校验，拒绝覆盖：${error instanceof Error?error.message:String(error)}`);
  }
}
async function syncFile(pathname,bytes){
  const fd=await open(pathname,'wx',0o600);
  try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
}
async function syncDirectory(dirname){
  if(process.platform==='win32')return;
  const fd=await open(dirname,'r');
  try{await fd.sync();}finally{await fd.close();}
}
async function removeTree(rootname){
  await chmod(rootname,0o700).catch(()=>{});
  try{
    const entries=await readdir(rootname,{recursive:true,withFileTypes:true});
    for(const entry of entries){
      const target=path.join(entry.parentPath,entry.name);
      await chmod(target,entry.isDirectory()?0o700:0o600).catch(()=>{});
    }
  }catch(error){if(error?.code!=='ENOENT')throw error;}
  await chmod(rootname,0o700).catch(()=>{});
  await rm(rootname,{recursive:true,force:true});
}
async function publishFile(target,bytes){
  const temporary=path.join(path.dirname(target),`.${path.basename(target)}-${randomUUID()}.tmp`);
  await syncFile(temporary,bytes);
  let hadExisting=false;
  try{
    await chmod(temporary,0o400);
    try{await chmod(target,0o600);hadExisting=true;}
    catch(error){if(error?.code!=='ENOENT')throw error;}
    await rename(temporary,target);
    await syncDirectory(path.dirname(target));
  }catch(error){
    if(hadExisting)await chmod(target,0o400).catch(()=>{});
    throw error;
  }finally{
    await chmod(temporary,0o600).catch(()=>{});
    await rm(temporary,{force:true}).catch(()=>{});
  }
}
async function acquireLock(pathname,target){
  const token=randomUUID();
  const body=Buffer.from(JSON.stringify({pid:process.pid,created_at:new Date().toISOString(),target,token}),'utf8');
  try{
    const handle=await open(pathname,'wx',0o600);
    try{await handle.writeFile(body);await handle.sync();}catch(error){await handle.close();await rm(pathname,{force:true});throw error;}
    return {pathname,token,handle};
  }catch(error){
    if(error?.code==='EEXIST')throw new Error(`另一个账簿同步进程正在运行，或上次异常退出留下锁文件。确认没有同步进程后手动删除：${pathname}`);
    throw error;
  }
}
async function releaseLock(lock){
  await lock.handle.close().catch(()=>{});
  try{
    const current=JSON.parse(await readFile(lock.pathname,'utf8'));
    if(current?.token===lock.token)await rm(lock.pathname,{force:true});
  }catch{}
}

const configPath=absolute(argument('--config')??process.env.ALLOCATION_LEDGER_SYNC_CONFIG,'账本同步配置文件');
const config=JSON.parse(await readFile(configPath,'utf8'));
if(config.schema_version!==1)throw new Error('账本同步配置版本无效');
const baseUrl=new URL(config.base_url);
const loopback=['127.0.0.1','localhost','[::1]'].includes(baseUrl.hostname);
if(baseUrl.protocol!=='https:'&&!(baseUrl.protocol==='http:'&&loopback))throw new Error('同步地址必须使用HTTPS；仅本机回环地址可使用HTTP');
if(baseUrl.username||baseUrl.password||baseUrl.pathname!=='/'||baseUrl.search||baseUrl.hash)throw new Error('同步地址必须是纯来源地址');
const tokenPath=absolute(config.token_file,'同步凭据文件');
const tokenInfo=await lstat(tokenPath);
if(!tokenInfo.isFile()||tokenInfo.isSymbolicLink())throw new Error('同步凭据必须是普通文件，不能是符号链接');
if(process.platform!=='win32'&&((tokenInfo.mode&0o077)!==0))throw new Error('同步凭据文件权限过宽，必须仅允许运行账号读取');
const token=(await readFile(tokenPath,'utf8')).trim();
if(!/^[a-f0-9]{64,}$/i.test(token))throw new Error('同步凭据必须是至少64位十六进制文本');
const target=absolute(config.target_directory,'本地快照目录');
const parent=path.dirname(target);
await mkdir(parent,{recursive:true,mode:0o700});
await ordinaryDirectoryChain(parent,'本地快照目录的上级目录');
const lockPath=path.join(parent,`.ledger-sync-${sha256(Buffer.from(target.toLowerCase(),'utf8')).slice(0,16)}.lock`);
const syncLock=await acquireLock(lockPath,target);

try{
const existing=await loadExistingManifest(target);
const previousManifest=existing?.manifest??null;

const response=await fetch(new URL('/api/ledger/export',baseUrl),{headers:{authorization:`Bearer ${token}`},cache:'no-store',redirect:'error'});
if(!response.ok){
  const detail=await response.text().catch(()=> '');
  throw new Error(`网站拒绝账簿同步（HTTP ${response.status}）：${detail.slice(0,500)}`);
}
const declared=Number(response.headers.get('content-length')??'0');
if(Number.isFinite(declared)&&declared>MAX_DOWNLOAD_BYTES)throw new Error('账簿下载超过100MB上限');
const zipBytes=new Uint8Array(await response.arrayBuffer());
if(!zipBytes.length||zipBytes.length>MAX_DOWNLOAD_BYTES)throw new Error('账簿下载为空或超过100MB上限');
const zip=await JSZip.loadAsync(zipBytes,{checkCRC32:true});
const roots=new Set(Object.values(zip.files).filter(item=>!item.dir).map(item=>item.name.split('/')[0]));
if(roots.size!==1)throw new Error('账簿压缩包必须只有一个快照文件夹');
const manifestEntry=Object.values(zip.files).find(item=>!item.dir&&item.name.endsWith(`/${MANIFEST_NAME}`));
if(!manifestEntry)throw new Error('账簿压缩包缺少账簿清单.json');
const manifestBytes=await manifestEntry.async('uint8array');
const {manifest}=parseManifest(manifestBytes,'账簿清单');
const declaredDigest=manifest.stateDigest;
if(response.headers.get('x-allocation-workspace-version')!==String(manifest.workspaceVersion))throw new Error('下载版本与账簿清单不一致');
if(response.headers.get('x-allocation-ledger-sha256')?.toLowerCase()!==declaredDigest.toLowerCase())throw new Error('下载摘要与账簿清单不一致');
if(previousManifest){
  if(manifest.workspaceVersion<previousManifest.workspaceVersion)throw new Error('网站返回的账簿版本早于本地快照，已拒绝回滚');
  if(manifest.workspaceVersion===previousManifest.workspaceVersion&&declaredDigest.toLowerCase()!==previousManifest.stateDigest.toLowerCase())throw new Error('同一网站版本返回了不同账簿摘要，已拒绝覆盖本地快照');
}
if(!Array.isArray(manifest.sources)||!manifest.sources.length)throw new Error('账簿清单没有金额来源');
if(new Set(manifest.sources.map(source=>source.id)).size!==manifest.sources.length)throw new Error('账簿来源编号重复');
if(new Set(manifest.sources.map(source=>source.priority)).size!==manifest.sources.length)throw new Error('账簿来源优先级重复');

// Unchanged state is safe to re-acknowledge. The server no longer includes an
// export timestamp in stateDigest, so this path must remain stable across pulls.
if(previousManifest&&previousManifest.workspaceVersion===manifest.workspaceVersion
  &&previousManifest.stateDigest.toLowerCase()===declaredDigest.toLowerCase()){
  const receipt={
    schema_version:1,received_at:new Date().toISOString(),workspace_version:manifest.workspaceVersion,state_digest:manifest.stateDigest,
    snapshot_directory:path.relative(target,existing.root),source_count:manifest.sources.length,
    source_available_cents:manifest.sources.reduce((sum,source)=>sum+source.availableCents,0),
  };
  const receiptBytes=Buffer.from(JSON.stringify(receipt,null,2),'utf8');
  try{
    const oldReceipt=JSON.parse(await readFile(path.join(target,RECEIPT_NAME),'utf8'));
    const sameReceipt=oldReceipt?.workspace_version===receipt.workspace_version
      &&String(oldReceipt?.state_digest).toLowerCase()===receipt.state_digest.toLowerCase()
      &&oldReceipt?.snapshot_directory===receipt.snapshot_directory;
    if(!sameReceipt)await publishFile(path.join(target,RECEIPT_NAME),receiptBytes);
  }catch{
    await publishFile(path.join(target,RECEIPT_NAME),receiptBytes);
  }
  console.log(JSON.stringify({
    ok:true,unchanged:true,target,snapshotDirectory:existing.root,workspaceVersion:manifest.workspaceVersion,
    stateDigest:manifest.stateDigest,
    sources:manifest.sources.map(source=>({priority:source.priority,name:source.name,availableCents:source.availableCents,file:source.file})),
  },null,2));
}else{
const versionsRoot=path.join(target,'versions');
const versionName=snapshotDirectoryName(manifest);
const versionDirectory=path.join(versionsRoot,versionName);
const temp=path.join(parent,`.ledger-sync-stage-${randomUUID()}`);
let targetCreated=false;
let installedVersion=false;
try{
  // A first sync may create the target root, but it must never leave a
  // half-created ledger behind when a later validation or publish fails.
  // Later versions publish into the already validated target.
  if(existing){
    const existingTarget=await lstat(target);
    if(!existingTarget.isDirectory()||existingTarget.isSymbolicLink())throw new Error('目标快照根路径不是普通目录');
  }else{
    await mkdir(target,{mode:0o700});
    targetCreated=true;
  }
  await mkdir(temp,{mode:0o700});
  for(const source of manifest.sources){
    safeRelative(source.file,'source');
    const expectedHash=assertDigest(source.sha256,`来源“${source.name??source.id}”的文件摘要`);
    const entry=zip.file(`${String(manifestEntry.name).split('/')[0]}/${source.file}`);
    if(!entry)throw new Error(`账簿缺少来源文件：${source.file}`);
    const bytes=new Uint8Array(await entry.async('uint8array'));
    if(sha256(bytes)!==expectedHash)throw new Error(`来源文件哈希不符：${source.name}`);
    if(!Number.isSafeInteger(source.priority)||source.priority<1)throw new Error(`账簿来源优先级无效：${source.name}`);
    const available=Number(source.availableCents),original=Number(source.originalCents),used=Number(source.usedCents);
    if(!Number.isSafeInteger(available)||!Number.isSafeInteger(original)||!Number.isSafeInteger(used)||available<0||used<0||original!==available+used)throw new Error(`账簿对账不平：${source.name}`);
    const destination=path.resolve(temp,...source.file.split('/'));
    if(!destination.startsWith(temp+path.sep))throw new Error('来源文件越出目标目录');
    await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
    await syncFile(destination,bytes);
    await syncDirectory(path.dirname(destination));
  }
  for(const item of manifest.taxFiles??[]){
    safeRelative(item.name,'tax');
    const expectedHash=assertDigest(item.sha256,`税务资料“${item.name}”的摘要`);
    const entry=zip.file(`${String(manifestEntry.name).split('/')[0]}/${item.name}`);
    if(!entry)throw new Error(`账簿缺少税务资料：${item.name}`);
    const bytes=new Uint8Array(await entry.async('uint8array'));
    if(sha256(bytes)!==expectedHash)throw new Error(`税务资料哈希不符：${item.name}`);
    const destination=path.resolve(temp,...item.name.split('/'));
    if(!destination.startsWith(temp+path.sep))throw new Error('税务资料越出目标目录');
    await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
    await syncFile(destination,bytes);
    await syncDirectory(path.dirname(destination));
  }
  await syncFile(path.join(temp,MANIFEST_NAME),manifestBytes);
  await verifySnapshotFiles(temp,manifest,'下载快照');
  await syncDirectory(temp);
  await mkdir(target,{recursive:true,mode:0o700});
  const targetInfo=await lstat(target);
  if(!targetInfo.isDirectory()||targetInfo.isSymbolicLink())throw new Error('目标快照根路径不是普通目录');
  try{await mkdir(versionsRoot,{mode:0o700});}
  catch(error){if(error?.code!=='EEXIST')throw error;}
  const versionsInfo=await lstat(versionsRoot);
  if(!versionsInfo.isDirectory()||versionsInfo.isSymbolicLink())throw new Error('versions 目录不能是符号链接');
  await syncDirectory(target);
  await syncDirectory(versionsRoot);
  let versionExists=false;
  try{
    const old=await lstat(versionDirectory);
    if(!old.isDirectory()||old.isSymbolicLink())throw new Error('目标版本路径已存在且不是普通目录');
    versionExists=true;
  }
  catch(error){if(error?.code!=='ENOENT')throw error;}
  if(versionExists){
    const innerManifest=await regularFile(versionDirectory,MANIFEST_NAME,'目标版本目录账簿清单');
    if(sha256(innerManifest.bytes)!==sha256(manifestBytes))throw new Error('目标版本目录内的账簿清单与下载内容不一致');
    await verifySnapshotFiles(versionDirectory,manifest,'已下载版本');
    await removeTree(temp);
  }else{
    await rename(temp,versionDirectory);
    installedVersion=true;
    // Keep the staging tree writable until after the directory rename. Some
    // Linux filesystems reject renaming a read-only directory even though the
    // source and destination parents are writable.
    const entries=await readdir(versionDirectory,{recursive:true,withFileTypes:true});
    for(const entry of entries.sort((a,b)=>b.parentPath.length-a.parentPath.length)){
      if(entry.isFile())await chmod(path.join(entry.parentPath,entry.name),0o400);
      else if(entry.isDirectory())await chmod(path.join(entry.parentPath,entry.name),0o500);
    }
    await chmod(versionDirectory,0o500);
    await syncDirectory(versionsRoot);
  }
  // The current manifest is the only moving pointer. Immutable version files
  // are installed first, so a crash leaves either the old or new ledger valid.
  await publishFile(path.join(target,MANIFEST_NAME),manifestBytes);
  const receiptBytes=Buffer.from(JSON.stringify({
    schema_version:1,received_at:new Date().toISOString(),workspace_version:manifest.workspaceVersion,state_digest:manifest.stateDigest,
    snapshot_directory:path.relative(target,versionDirectory),source_count:manifest.sources.length,
    source_available_cents:manifest.sources.reduce((sum,source)=>sum+source.availableCents,0),
  },null,2),'utf8');
  await publishFile(path.join(target,RECEIPT_NAME),receiptBytes);
  console.log(JSON.stringify({
    ok:true,target,snapshotDirectory:versionDirectory,workspaceVersion:manifest.workspaceVersion,stateDigest:manifest.stateDigest,
    sources:manifest.sources.map(source=>({priority:source.priority,name:source.name,availableCents:source.availableCents,file:source.file})),
  },null,2));
}catch(error){
  await removeTree(temp);
  if(installedVersion)await removeTree(versionDirectory);
  if(targetCreated)await removeTree(target);
  throw error;
}
}
}finally{
  await releaseLock(syncLock);
}
