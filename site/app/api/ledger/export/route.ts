import { timingSafeEqual } from 'node:crypto';
import { env } from '../../../lib/node-runtime';
import { getAppUser } from '../../../lib/app-auth';
import { loadWorkspace, readFile } from '../../../lib/persistence';
import { digest, zipFiles } from '../../../lib/spreadsheets';

export const dynamic='force-dynamic';

function bearerAllowed(request:Request):boolean{
  const expected=env.ALLOCATION_SYNC_TOKEN;
  const header=request.headers.get('authorization')??'';
  if(!expected||!/^Bearer [a-f0-9]{64,}$/i.test(header))return false;
  const actual=header.slice(7);
  const a=Buffer.from(actual,'utf8'),b=Buffer.from(expected,'utf8');
  return a.length===b.length&&timingSafeEqual(a,b);
}

export async function GET(request:Request){
  try{
    if(!bearerAllowed(request)){
      const user=await getAppUser();
      if(!user)return Response.json({error:'请先登录或使用账簿同步凭据。'},{status:401});
      if(user.mustChangePassword)return Response.json({error:'请先修改初始密码。'},{status:403});
    }
    const {version,state}=await loadWorkspace();
    const files:{name:string;bytes:Uint8Array}[]=[];
    const sources=[];
    for(const source of state.sources??[]){
      if(!source.fileKey)throw new Error(`来源${source.name??source.id}缺少已登记文件。`);
      const stored=await readFile(source.fileKey);
      if(!stored)throw new Error(`来源${source.name??source.id}的快照文件缺失。`);
      const actual=await digest(stored.bytes);
      if(typeof source.sha256!=='string'||actual!==source.sha256.toLowerCase())throw new Error(`来源${source.name??source.id}的快照哈希不符。`);
      const availableCents=(source.rows??[]).filter((row:any)=>!row.historicUsed).reduce((sum:number,row:any)=>sum+Number(row.amountCents),0);
      const usedCents=(source.history??[]).reduce((sum:number,row:any)=>sum+Number(row.usedCents),0);
      if(!Number.isSafeInteger(availableCents)||!Number.isSafeInteger(usedCents)||source.originalCents!==availableCents+usedCents)throw new Error(`来源${source.name??source.id}账簿对账不平。`);
      files.push({name:`来源/第${String(source.priority).padStart(2,'0')}来源.xlsx`,bytes:stored.bytes});
      sources.push({
        id:source.id,priority:source.priority,name:source.name,fileName:source.fileName,file:`来源/第${String(source.priority).padStart(2,'0')}来源.xlsx`,
        sha256:actual,originalCents:source.originalCents,availableCents,usedCents,rowCount:(source.rows??[]).filter((row:any)=>!row.historicUsed).length,
        history:source.history??[],rowsSha256:await digest(JSON.stringify(source.rows??[])),
      });
    }
    const taxEntries=[];
    for(const [kind,file] of [['taxFile',state.taxFile],['taxOverrideFile',state.taxOverrideFile]] as const){
      if(!file?.key)continue;
      const stored=await readFile(file.key);
      if(!stored)throw new Error(`${kind==='taxFile'?'税务主体':'税务修正'}快照文件缺失。`);
      const actual=await digest(stored.bytes);
      if(!file.sha256||actual!==file.sha256.toLowerCase())throw new Error(`${kind==='taxFile'?'税务主体':'税务修正'}快照哈希不符。`);
      const name=kind==='taxFile'?'税务主体.xlsx':'税务修正.json';
      files.push({name:`资料/${name}`,bytes:stored.bytes});
      taxEntries.push({kind,name:`资料/${name}`,sha256:actual});
    }
    // The digest describes ledger state only. Transfer timestamps must never
    // make an unchanged workspace look like a divergent same-version ledger.
    const summary={
      schemaVersion:1,workspaceVersion:version,sources,taxFiles:taxEntries,
      productHistory:state.productHistory??[],
      instruction:'网站数据库是该批余额的唯一正式账簿；本地Excel仅为附带版本与哈希的只读快照。正式分摊只能从此版本继续。',
    };
    const stateDigest=await digest(JSON.stringify(summary));
    const manifest={...summary,stateDigest};
    const folder=`网站账簿快照_v${version}`;
    const zip=await zipFiles(folder,files,{'账簿清单.json':JSON.stringify(manifest,null,2)});
    return new Response(zip as BodyInit,{headers:{
      'Content-Type':'application/zip',
      'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(`分摊网站账簿_v${version}.zip`)}`,
      'Cache-Control':'no-store',
      'X-Allocation-Workspace-Version':String(version),
      'X-Allocation-Ledger-Sha256':stateDigest,
    }});
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:'账簿导出失败。'},{status:400,headers:{'Cache-Control':'no-store'}});
  }
}
