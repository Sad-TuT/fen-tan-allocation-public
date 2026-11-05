import { getAppUser } from '../../lib/app-auth';
import { stateSummary,importSource,importTax,importTaxOverrides,simulate,prepareBatch,finalize,getBatch,getReviews } from '../../lib/workflow';
import {hasTrustedOrigin,requestAddress} from '../../lib/request-security';
import {tryAcquireUploadSlot} from '../../lib/upload-gate';
import {lstat,readFile} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import path from 'node:path';

async function hasCommitAuthorization(request:Request):Promise<boolean>{
  const pathname=process.env.ALLOCATION_COMMIT_TOKEN_FILE;
  const provided=request.headers.get('x-allocation-commit-token')?.trim()??'';
  if(!pathname||!path.isAbsolute(pathname)||!/^[a-f0-9]{64,}$/i.test(provided))return false;
  try{
    const info=await lstat(pathname);
    if(!info.isFile()||info.isSymbolicLink()||info.size>1024
      ||(process.platform!=='win32'&&((info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))))return false;
    const expected=(await readFile(pathname,'utf8')).trim();
    return /^[a-f0-9]{64,}$/i.test(expected)
      &&provided.length===expected.length
      &&timingSafeEqual(Buffer.from(provided),Buffer.from(expected));
  }catch{return false;}
}
export const dynamic='force-dynamic';
export async function GET(request:Request){if(!requestAddress(request))return Response.json({error:'请求地址不受信任。'},{status:403});const user=await getAppUser();if(!user)return Response.json({error:'请先登录。'},{status:401});if(user.mustChangePassword)return Response.json({error:'请先修改初始密码。'},{status:403});try{return Response.json({...(await stateSummary()),user:{name:user.displayName,email:user.email,role:user.role}},{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:e instanceof Error?e.message:'读取失败'},{status:500});}}
export async function POST(request:Request){const user=await getAppUser();if(!user)return Response.json({error:'请先登录。'},{status:401});if(user.mustChangePassword)return Response.json({error:'请先修改初始密码。'},{status:403});if(!hasTrustedOrigin(request))return Response.json({error:'来源不受信任'},{status:403});
  try{const ct=request.headers.get('content-type')??'';if(ct.includes('multipart/form-data')){if(user.role==='viewer')return Response.json({error:'查看账号不能修改数据。'},{status:403});const rawLength=request.headers.get('content-length');if(rawLength!==null){const announced=Number(rawLength);if(!Number.isFinite(announced)||announced<=0||announced>12*1024*1024)return Response.json({error:'上传请求为空或超过12MB。'},{status:413});}const release=tryAcquireUploadSlot();if(!release)return Response.json({error:'当前文件处理任务已满，请稍后重试。'},{status:429,headers:{'Retry-After':'15'}});try{const f=await request.formData();const file=f.get('file');const action=String(f.get('action'));const expectedExtension=action==='tax-overrides'?'.json':'.xlsx';if(!(file instanceof File)||file.size===0||file.size>10*1024*1024||!file.name.toLowerCase().endsWith(expectedExtension))throw new Error(`请上传不超过10MB的${expectedExtension}文件。`);const bytes=new Uint8Array(await file.arrayBuffer());const version=Number(f.get('version'));if(!Number.isSafeInteger(version)||version<0)throw new Error('版本无效，请刷新。');let result;
    if(action==='source')result=await importSource(bytes,file.name,version,user.userId,{priority:Number(f.get('priority')),history:String(f.get('history')??'').split(/[／/\n]/).map(s=>s.trim()).filter(Boolean),independentConfirmed:String(f.get('independentConfirmed')??'')==='true',sourceReference:String(f.get('sourceReference')??'')});
    else if(action==='tax')result=await importTax(bytes,file.name,version,user.userId);
    else if(action==='tax-overrides')result=await importTaxOverrides(bytes,file.name,version,user.userId);
    else if(action==='prepare')result=await prepareBatch({product:String(f.get('product')??''),price:String(f.get('price')??''),quantity:Number(f.get('quantity')),version},bytes,file.name,user.userId);
    else throw new Error('不支持此操作。');return Response.json(result);}finally{release();}
  }
  if(!ct.toLowerCase().startsWith('application/json'))return Response.json({error:'请求格式无效。'},{status:415});const b=await request.json() as Record<string,unknown>;if(b.action==='simulate'){if(typeof b.version!=='number'||!Number.isSafeInteger(b.version)||b.version<0)throw new Error('余额版本无效，请刷新后重新试算。');return Response.json(await simulate(String(b.product??''),String(b.price??''),Number(b.quantity),b.version));}
  if(b.action==='commit'){if(user.role==='viewer')return Response.json({error:'查看账号不能修改数据。'},{status:403});if(!await hasCommitAuthorization(request))return Response.json({error:'需要独立入账控制凭据。'},{status:403});return Response.json(await finalize(String(b.id),user.userId));}if(b.action==='batch'){const batch=await getBatch(String(b.id));if(!batch)throw new Error('批次不存在。');return Response.json({...batch,reviews:await getReviews(String(b.id))});}throw new Error('不支持此操作。');
  }catch(e){return Response.json({error:e instanceof Error?e.message:'处理失败，请核实资料。'},{status:400});}}
