import { getAppUser } from '../../lib/app-auth';
import { stateSummary,importSource,importTax,importTaxOverrides,simulate,prepareBatch,finalize,getBatch,getReviews } from '../../lib/workflow';
import {hasTrustedOrigin,requestAddress} from '../../lib/request-security';
import type { DepartmentAssignment } from '../../lib/allocation';

function assignments(value: unknown): DepartmentAssignment[] {
  if (!Array.isArray(value) || value.length > 30000) throw new Error('部门归属格式无效，请重新试算。');
  return value as DepartmentAssignment[]; // Allocation validates every identity and candidate against the current snapshot.
}
export const dynamic='force-dynamic';
export async function GET(request:Request){if(!requestAddress(request))return Response.json({error:'请求地址不受信任。'},{status:403});const user=await getAppUser();if(!user)return Response.json({error:'请先登录。'},{status:401});if(user.mustChangePassword)return Response.json({error:'请先修改初始密码。'},{status:403});try{return Response.json({...(await stateSummary()),user:{name:user.displayName,email:user.email,role:user.role}},{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:e instanceof Error?e.message:'读取失败'},{status:500});}}
export async function POST(request:Request){const user=await getAppUser();if(!user)return Response.json({error:'请先登录。'},{status:401});if(user.mustChangePassword)return Response.json({error:'请先修改初始密码。'},{status:403});if(!hasTrustedOrigin(request))return Response.json({error:'来源不受信任'},{status:403});
  try{const ct=request.headers.get('content-type')??'';if(ct.includes('multipart/form-data')){if(user.role==='viewer')return Response.json({error:'查看账号不能修改数据。'},{status:403});const f=await request.formData();const file=f.get('file');const action=String(f.get('action'));const expectedExtension=action==='tax-overrides'?'.json':'.xlsx';if(!(file instanceof File)||file.size===0||file.size>10*1024*1024||!file.name.toLowerCase().endsWith(expectedExtension))throw new Error(`请上传不超过10MB的${expectedExtension}文件。`);const bytes=new Uint8Array(await file.arrayBuffer());const version=Number(f.get('version'));if(!Number.isSafeInteger(version)||version<0)throw new Error('版本无效，请刷新。');let result;
    if(action==='source')result=await importSource(bytes,file.name,version,user.userId,{priority:Number(f.get('priority')),history:String(f.get('history')??'').split(/[／/\n]/).map(s=>s.trim()).filter(Boolean),independentConfirmed:String(f.get('independentConfirmed')??'')==='true',sourceReference:String(f.get('sourceReference')??'')});
    else if(action==='tax')result=await importTax(bytes,file.name,version,user.userId);
    else if(action==='tax-overrides')result=await importTaxOverrides(bytes,file.name,version,user.userId);
    else if(action==='prepare'){let parsed:unknown;try{parsed=JSON.parse(String(f.get('assignments')??'[]'));}catch{throw new Error('部门归属格式无效，请重新试算。');}result=await prepareBatch({product:String(f.get('product')??''),price:String(f.get('price')??''),quantity:Number(f.get('quantity')),version,assignments:assignments(parsed)},bytes,file.name,user.userId);}
    else throw new Error('不支持此操作。');return Response.json(result);
  }
  if(!ct.toLowerCase().startsWith('application/json'))return Response.json({error:'请求格式无效。'},{status:415});const b=await request.json() as Record<string,unknown>;if(b.action==='simulate'){if(typeof b.version!=='number'||!Number.isSafeInteger(b.version)||b.version<0)throw new Error('余额版本无效，请刷新后重新试算。');return Response.json(await simulate(String(b.product??''),String(b.price??''),Number(b.quantity),b.version,assignments(b.assignments??[])));}
  if(b.action==='commit'){if(user.role==='viewer')return Response.json({error:'查看账号不能修改数据。'},{status:403});return Response.json(await finalize(String(b.id),user.userId));}if(b.action==='batch'){const batch=await getBatch(String(b.id));if(!batch)throw new Error('批次不存在。');return Response.json({...batch,reviews:await getReviews(String(b.id))});}throw new Error('不支持此操作。');
  }catch(e){if(e && typeof e==='object' && 'code' in e && e.code==='AMBIGUOUS_ASSIGNMENT' && 'ambiguities' in e && Array.isArray(e.ambiguities))return Response.json({error:e instanceof Error?e.message:'部门归属待确认',code:'AMBIGUOUS_ASSIGNMENT',ambiguities:e.ambiguities},{status:400});return Response.json({error:e instanceof Error?e.message:'处理失败，请核实资料。'},{status:400});}}
