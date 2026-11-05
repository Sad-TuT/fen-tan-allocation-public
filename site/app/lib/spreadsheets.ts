import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { validateXlsxArchive } from './xlsx-limits';
import { normalizeSpreadsheetNamespaces } from './xlsx-namespace-compat';
import { normalizeLegalEntity, type Source, type SourceRow, type AllocationPlan, type AllocationGroup } from './allocation';

export type ImportedRow = SourceRow & { sheetRow: number; rawValues: unknown[] };
export type ImportedSource = Omit<Source, 'rows'> & { fileKey?: string; fileName: string; sha256: string; sheetName: string; headerRow: number; columns: Record<string, number>; rows: ImportedRow[] };
export type TaxRecord = { code: string; name: string; kind: string; credit: string; address: string; bank: string; account: string; sourceRow: number; issues: string[] };
export type TaxOverride = {
  code:string; name?:string; kind?:string; credit?:string; address?:string; bank?:string; account?:string;
  confirmedByUser:true; reason:string; appliesToAllFutureBatches:boolean; effectiveFromUtc?:string;
  batchIds:string[]; sourceRow:number;
};
export type TaxDecision = { mode: 'normal'|'credit'|'proforma'|'pending'; text: string; reason: string; taxRow?: number };
export type ProductHistory = { batchId: string; product: string };
export type GeneratedFile = { name: string; role: string; bytes: Uint8Array; sha256: string; sourceId?: string };
const fieldLabels: Record<string,string[]> = { applicant:['申领人'], department:['申领部门'], useCenter:['使用部门','使用中心'], costCenter:['成本中心'], amount:['成本','金额'], legalEntity:['费用承担法律主体'], purpose:['申领用途'] };

export function cents(value: unknown): number {
  const s = String(value ?? '').replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) throw new Error(`金额“${s}”必须是非负、最多两位小数的数字。`);
  const [whole, decimal=''] = s.split('.');
  const result = Number(whole)*100 + Number(decimal.padEnd(2,'0'));
  if (!Number.isSafeInteger(result)) throw new Error('金额超出可精确处理的范围。');
  return result;
}
export async function digest(value: Uint8Array|string): Promise<string> {
  const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
  const result=await crypto.subtle.digest('SHA-256',bytes as BufferSource);
  return Array.from(new Uint8Array(result),x=>x.toString(16).padStart(2,'0')).join('');
}
/**
 * Identifies a balance by monetary invariants only. Row labels, physical rows,
 * hidden metadata, file name and the workbook hash are deliberately excluded:
 * every one of them is editable and can otherwise make a copied balance look
 * new. Repeating, splitting or relabelling a row cannot change these totals.
 */
export async function sourceBalanceFingerprint(source:Pick<Source,'originalCents'|'history'|'rows'>):Promise<string>{
  const historyCents=source.history.map(item=>item.usedCents).sort((a,b)=>a-b);
  const availableCents=source.rows.filter(row=>!row.historicUsed).reduce((sum,row)=>sum+row.amountCents,0);
  return digest(JSON.stringify({
    schemaVersion:2,
    originalCents:source.originalCents,
    previousUsedCents:historyCents.reduce((sum,value)=>sum+value,0),
    availableCents,
    historyCents,
  }));
}
function normalizedActiveRowShapes(source:Pick<Source,'rows'>):string[][]{
  const normalize=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ');
  const seen=new Set<string>();
  return source.rows.filter(row=>!row.historicUsed).map(row=>[
    normalize(row.applicant),
    normalize(row.department),
    normalize(row.useCenter),
    normalize(row.costCenter),
    normalizeLegalEntity(row.legalEntity).key,
    normalize(row.purpose),
  ]).filter(row=>{const key=JSON.stringify(row);if(seen.has(key))return false;seen.add(key);return true;});
}
async function sourceRowShapeFingerprint(source:Pick<Source,'rows'>):Promise<string>{
  const rows=normalizedActiveRowShapes(source).map(row=>JSON.stringify(row)).sort();
  return digest(JSON.stringify({schemaVersion:2,rows}));
}
function sourceRowsPartiallyOverlap(candidate:Pick<Source,'rows'>,existing:Pick<Source,'rows'>):boolean{
  const signatures=(source:Pick<Source,'rows'>)=>{
    const result=new Set<string>();
    for(const row of normalizedActiveRowShapes(source))
      for(let omitted=0;omitted<row.length;omitted++)result.add(JSON.stringify([omitted,row.filter((_,index)=>index!==omitted)]));
    return result;
  };
  const candidateSignatures=signatures(candidate);
  for(const signature of signatures(existing))if(candidateSignatures.has(signature))return true;
  return false;
}
function sourceReferenceKey(value:string|undefined):string{return (value??'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleUpperCase('en-US');}
export async function assertDistinctSourceBalance(candidate:ImportedSource,existing:Source[]):Promise<void>{
  const fingerprint=await sourceBalanceFingerprint(candidate);
  const rowShape=await sourceRowShapeFingerprint(candidate);
  const reference=candidate.sourceReference?.trim()??'';
  const referenceKey=sourceReferenceKey(reference);
  if(referenceKey&&existing.some(source=>sourceReferenceKey(source.sourceReference)===referenceKey))throw new Error(`来源编号“${reference}”已经使用，不能重复引用。`);
  const candidateAvailable=candidate.rows.filter(row=>!row.historicUsed).reduce((sum,row)=>sum+row.amountCents,0);
  let collision=false;
  for(const source of existing){
    const known=Array.isArray(source.balanceFingerprints)?source.balanceFingerprints:[];
    const sourceAvailable=source.rows.filter(row=>!row.historicUsed).reduce((sum,row)=>sum+row.amountCents,0);
    // A repeated original total or current available balance is enough to stop.
    // The second check also catches an edit that changes both the opening total
    // and historical used amount while leaving the spendable balance unchanged.
    // The full fingerprint catches text edits, row splitting and prior versions.
    if(source.originalCents===candidate.originalCents||sourceAvailable===candidateAvailable||known.includes(fingerprint)||await sourceBalanceFingerprint(source)===fingerprint||await sourceRowShapeFingerprint(source)===rowShape||sourceRowsPartiallyOverlap(candidate,source))collision=true;
  }
  if(!collision)return;
  throw new Error('该文件命中现有来源的原总额、当前可用金额、资金指纹或来源行结构。自动检查不能用新编号或人工声明证明这是独立余额；请停止导入并结合财务凭证核实承接关系，不能重复计入网站余额。');
}
function val(cell: ExcelJS.Cell): unknown { if(cell.type===ExcelJS.ValueType.Formula)return cell.result; const v=cell.value; if(v && typeof v==='object'){if('result' in v)return v.result;if('richText' in v)return v.richText.map(x=>x.text).join('');if('text' in v)return v.text;}return v; }
function text(cell: ExcelJS.Cell): string { const v=val(cell);return v===null||v===undefined?'':String(v); }
function red(cell: ExcelJS.Cell): boolean {const c=cell.font?.color as (Partial<ExcelJS.Color>&{indexed?:number})|undefined;return !!(c && (c.argb?.slice(-6).toUpperCase()==='FF0000'||c.indexed===2||c.indexed===10));}
function columnNumber(label:string):number{let value=0;for(const char of label.toUpperCase())value=value*26+char.charCodeAt(0)-64;return value;}
function referenceTouchesColumn(ref:string,column:number,afterRow:number):boolean{
  const parts=ref.trim().split(/(?:\s+|,)+/).filter(Boolean);
  if(!parts.length)return true;
  return parts.some((part)=>{
    const match=part.match(/^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/);
    // Conditional formatting that cannot be mapped to a concrete cell range
    // is unsafe because it may hide runtime-used rows. Treat it as touching.
    if(!match)return true;
    const startColumn=columnNumber(match[1]),endColumn=columnNumber(match[3]??match[1]);
    const startRow=Number(match[2]),endRow=Number(match[4]??match[2]);
    return startColumn<=column&&column<=endColumn&&startRow<=endRow&&endRow>afterRow;
  });
}
function moneyValue(cell: ExcelJS.Cell): number {const v=val(cell);if(typeof v!=='string'&&typeof v!=='number')throw new Error(`${cell.address}的金额没有可用计算结果，请在Excel重算保存后上传。`);return cents(v);}
async function load(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  validateXlsxArchive(bytes);
  try { const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes as never);return wb; }
  catch (originalError) {
    const normalized=await normalizeSpreadsheetNamespaces(bytes);
    if (!normalized) throw originalError;
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(normalized as never);return wb;
  }
}

export async function parseSource(bytes: Uint8Array, fileName: string, priority: number): Promise<ImportedSource> {
  const wb=await load(bytes);let sheet:ExcelJS.Worksheet|undefined;let headerRow=0;let columns:Record<string,number>={};
  for(const ws of wb.worksheets){if(ws.name==='_分摊元数据')continue;for(let r=1;r<=Math.min(ws.rowCount,20);r++){
    const found:Record<string,number>={};ws.getRow(r).eachCell((cell,c)=>{const label=text(cell).trim();for(const [field,aliases]of Object.entries(fieldLabels))if(aliases.includes(label))found[field]=c;});
    if(Object.keys(fieldLabels).every(k=>found[k])){sheet=ws;headerRow=r;columns=found;break;}
  }if(sheet)break;}
  if(!sheet)throw new Error('未找到完整表头，需要申领人、申领部门、使用部门、成本中心、成本、费用承担法律主体、申领用途。');
  if(headerRow<3)throw new Error('来源表前两行需要保留对账区域，请将明细表头放在第3行或之后。');
  if(text(sheet.getCell(headerRow,9))==='来源编号')throw new Error('这是内部合并余额表。请分别上传各来源剩余表，避免重复计入同一余额。');
  const conditionalCostFormatting=(sheet as ExcelJS.Worksheet&{conditionalFormattings?:ExcelJS.ConditionalFormattingOptions[]}).conditionalFormattings?.some(option=>
    referenceTouchesColumn(option.ref,columns.amount,headerRow));
  if(conditionalCostFormatting)throw new Error(`成本列${sheet.getColumn(columns.amount).letter}含有条件格式，网站无法离线判断运行时实际使用状态。请先在Excel中固化红字/红底并删除成本列条件格式后重新上传，确认每笔历史已用金额只计一次。`);
  const sha256=await digest(bytes);let metadata:any=null;
  const meta=wb.getWorksheet('_分摊元数据');if(meta){try{metadata=JSON.parse(Array.from({length:meta.rowCount},(_,i)=>text(meta.getCell(i+1,1))).join(''));}catch{throw new Error('表内来源追踪信息损坏，请使用未修改的剩余表。');}}
  const id=metadata?.sourceId??`src_${sha256.slice(0,16)}`;const history:Source['history']=[];
  if(metadata?.history)history.push(...metadata.history);else if(headerRow>=3){for(let c=9;c<=sheet.columnCount;c++){const product=text(sheet.getCell(1,c));const v=val(sheet.getCell(2,c));if(product && !/原总额|剩余|累计|差额/.test(product) && (typeof v==='number'||typeof v==='string'))history.push({batchId:`legacy_col${c}_${product}`,product,usedCents:cents(v)});}}
  const rows:ImportedRow[]=[];let historicRedCents=0;
  for(let r=headerRow+1;r<=sheet.rowCount;r++){
    const cost=sheet.getCell(r,columns.amount);if(val(cost)===null||val(cost)===undefined||val(cost)==='')continue;
    const amountCents=moneyValue(cost);if(amountCents===0)continue;
    const old=metadata?.rows?.[String(r)];const row:any={id:old?.id??`${id}:row${r}`,sourceId:id,originalFile:old?.originalFile??fileName,originalRow:old?.originalRow??r,sheetRow:r,amountCents,historicUsed:red(cost),departmentResolution:old?.departmentResolution,rawValues:Array.from({length:8},(_,c)=>val(sheet!.getCell(r,c+1))??null)};
    for(const k of Object.keys(fieldLabels).filter(k=>k!=='amount'))row[k]=text(sheet.getCell(r,columns[k]));
    if(row.historicUsed)historicRedCents+=amountCents;rows.push(row);
  }
  if(!rows.length&&!history.length)throw new Error('来源表没有可读取的金额明细或历史登记。');
  if(historicRedCents && !history.length)history.push({batchId:'legacy_red',product:'历史已用（红字导入）',usedCents:historicRedCents});
  const before=rows.filter(r=>!r.historicUsed).reduce((a,r)=>a+r.amountCents,0);const previous=history.reduce((a,h)=>a+h.usedCents,0);
  const base=metadata?.originalCents??(headerRow>=3&&val(sheet.getCell('D2'))!==null?moneyValue(sheet.getCell('D2')):before+previous);
  if(!Number.isSafeInteger(base)||base!==before+previous)throw new Error(`来源顶部对账不一致：原额${base/100}元，未用${before/100}元，历史已用${previous/100}元。请核实后再导入。`);
  return {id,name:fileName.replace(/\.xlsx$/i,''),priority,allowBlankDepartment:metadata?.allowBlankDepartment === true,sourceReference:typeof metadata?.sourceReference==='string'?metadata.sourceReference:undefined,importAttestation:metadata?.importAttestation,balanceFingerprints:Array.isArray(metadata?.balanceFingerprints)?metadata.balanceFingerprints:undefined,originalCents:base,history,rows,fileName,sha256,sheetName:sheet.name,headerRow,columns};
}

export async function parseTaxes(bytes: Uint8Array): Promise<TaxRecord[]> {
  const wb=await load(bytes);const aliases:Record<string,string[]>={code:['法律主体编码','法律主体代码','公司编码'],name:['实际主体名称'],kind:['当前主体类型'],credit:['社会统一信用代码','统一社会信用代码'],address:['注册地址'],bank:['开户行'],account:['银行基本户账号','银行基本户帐号']};
  let ws:ExcelJS.Worksheet|undefined,header=0,cols:Record<string,number>={};
  for(const s of wb.worksheets){for(let r=1;r<=Math.min(15,s.rowCount);r++){const map:Record<string,number>={};s.getRow(r).eachCell((c,i)=>{for(const[k,names]of Object.entries(aliases))if(names.includes(text(c).trim()))map[k]=i;});if(map.code&&map.name&&map.kind&&map.credit){ws=s;header=r;cols=map;break;}}if(ws)break;}
  if(!ws)throw new Error('税务表需包含法律主体编码、实际主体名称、当前主体类型及社会统一信用代码等表头。');
  const result:TaxRecord[]=[];
  for(let r=header+1;r<=ws.rowCount;r++){const code=text(ws.getCell(r,cols.code)).trim();if(!code)continue;const item:any={sourceRow:r,issues:[]};for(const k of Object.keys(aliases)){item[k]=cols[k]?text(ws.getCell(r,cols[k])):'';if(['credit','account'].includes(k)&&cols[k]&&typeof val(ws.getCell(r,cols[k]))==='number')item.issues.push(`${k==='credit'?'信用代码':'银行账号'}在来源中为数值，请确认精度。`);}result.push(item);}
  return result;
}
export async function parseTaxOverrides(bytes: Uint8Array): Promise<TaxOverride[]> {
  let parsed:any;
  try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('税务修正文件必须是有效的UTF-8 JSON。');}
  const entities=parsed?.entities;
  if(!entities||typeof entities!=='object'||Array.isArray(entities))throw new Error('税务修正文件缺少entities对象。');
  const allowed=['name','kind','credit','address','bank','account'];
  const result:TaxOverride[]=[];
  for(const [code,value] of Object.entries(entities)){
    if(!/^[A-Za-z]\d{6}$/.test(code))throw new Error(`税务修正主体编码格式无效：${code}`);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${code}的税务修正格式无效。`);
    const item=value as Record<string,unknown>;
    if(item.confirmed_by_user!==true||typeof item.reason!=='string'||!item.reason.trim())throw new Error(`${code}的税务修正必须明确由用户确认并记录原因。`);
    const scope=(item.scope??{}) as Record<string,unknown>;
    const own=(key:string)=>Object.prototype.hasOwnProperty.call(item,key);
    const scoped=(key:string)=>Object.prototype.hasOwnProperty.call(scope,key);
    if(own('applies_to_all_future_batches')&&scoped('applies_to_all_future_batches'))throw new Error(`${code}的未来批次授权重复声明，请只保留一处。`);
    if(own('batch_ids')&&scoped('batch_ids'))throw new Error(`${code}的 batch_ids 重复声明，请只保留一处。`);
    if(own('effective_from_utc')&&scoped('effective_from_utc'))throw new Error(`${code}的 effective_from_utc 重复声明，请只保留一处。`);
    const appliesToAllFutureBatches=item.applies_to_all_future_batches===true||scope.applies_to_all_future_batches===true;
    const rawEffective=own('effective_from_utc')?item.effective_from_utc:scope.effective_from_utc;
    let effectiveFromUtc:string|undefined;
    if(appliesToAllFutureBatches){
      if(typeof rawEffective!=='string'||!rawEffective.trim()||!Number.isFinite(Date.parse(rawEffective))||!/[zZ]|[+-]\d\d:\d\d$/.test(rawEffective.trim()))throw new Error(`${code}的未来批次税务修正必须提供带时区的 effective_from_utc。`);
      effectiveFromUtc=rawEffective.trim();
    }
    const rawBatchIds=own('batch_ids')?item.batch_ids:scope.batch_ids;
    if(rawBatchIds!==undefined&&(!Array.isArray(rawBatchIds)||rawBatchIds.some(x=>typeof x!=='string'||!x.trim())))throw new Error(`${code}的 batch_ids 必须是非空文本数组。`);
    const batchIds=rawBatchIds===undefined?[]:[...new Set(rawBatchIds.map(x=>x.trim()))];
    if(Array.isArray(rawBatchIds)&&batchIds.length!==rawBatchIds.length)throw new Error(`${code}的 batch_ids 不能重复。`);
    if(appliesToAllFutureBatches&&batchIds.length)throw new Error(`${code}的税务修正不能同时声明 batch_ids 和未来批次授权，请只选择一种作用范围。`);
    if(!appliesToAllFutureBatches&&!batchIds.length)throw new Error(`${code}的税务修正必须限定适用批次，或明确授权用于未来批次。`);
    const corrected:any={code,confirmedByUser:true,reason:String(item.reason).trim(),appliesToAllFutureBatches,effectiveFromUtc,batchIds,sourceRow:result.length+2};
    let correctionCount=0;
    for(const key of allowed)if(item[key]!==undefined&&item[key]!==null){
      if(typeof item[key]!=='string'||!String(item[key]).trim())throw new Error(`${code}的税务修正字段${key}必须是非空文本。`);
      corrected[key]=String(item[key]);correctionCount++;
    }
    if(!correctionCount)throw new Error(`${code}的税务修正没有需要更正的字段。`);
    result.push(corrected);
  }
  if(!result.length)throw new Error('税务修正文件没有可用记录。');
  if(new Set(result.map(x=>x.code)).size!==result.length)throw new Error('税务修正主体编码重复。');
  return result;
}
export function taxDecision(entity:string,taxes:TaxRecord[],overrides:TaxOverride[]=[],batchId?:string,batchCreatedAt?:string):TaxDecision {
  const normalized=normalizeLegalEntity(entity);const candidates=normalized.code?taxes.filter(t=>t.code===normalized.code):[];
  if(candidates.length===0&&!/[\u3400-\u9fff]/u.test(normalized.name)&&/[A-Za-z]/.test(normalized.name))return{mode:'proforma',text:'形式发票',reason:'英文主体未找到对应税务资料'};
  if(!normalized.code)return{mode:'pending',text:'',reason:normalized.recognized?'法律主体缺少唯一可识别的公司代码':'法律主体中的公司代码不唯一或格式异常'};
  if(candidates.length!==1)return{mode:'pending',text:'',reason:candidates.length?'公司代码重复，需人工确认':'未找到唯一精确匹配的公司代码'};
  const t={...candidates[0]};const override=overrides.find(x=>x.code===normalized.code);
  if(override){
    const futureInScope=override.appliesToAllFutureBatches&&!!batchCreatedAt&&!!override.effectiveFromUtc
      &&Number.isFinite(Date.parse(batchCreatedAt))&&Date.parse(batchCreatedAt)>=Date.parse(override.effectiveFromUtc);
    const inScope=futureInScope||!!batchId&&override.batchIds.includes(batchId);
    if(!inScope)return{mode:'pending',text:'',reason:`存在用户确认的税务修正，但未授权用于批次${batchId??'未知批次'}`,taxRow:t.sourceRow};
    for(const key of ['name','kind','credit','address','bank','account'] as const)if(override[key]!==undefined)(t as any)[key]=override[key];
  }
  if(t.name!==normalized.name||t.issues.length)return{mode:'pending',text:'',reason:t.name!==normalized.name?'公司名称与代码对应的实际主体名称不一致':t.issues.join('；'),taxRow:t.sourceRow};
  if(['小规模纳税人','一般纳税人-简易征收'].includes(t.kind)&&t.credit)return{mode:'credit',text:t.credit,reason:'仅填写信用代码',taxRow:t.sourceRow};
  if(t.kind==='一般纳税人-一般征收'&&[t.name,t.credit,t.address,t.bank,t.account].every(Boolean))return{mode:'normal',text:[t.name,t.credit,t.address,t.bank,t.account,'','专票'].join('\n'),reason:'一般征收专票',taxRow:t.sourceRow};
  return{mode:'pending',text:'',reason:'主体类型未知或开票必要资料不完整',taxRow:t.sourceRow};
}
export function invoiceOrder(groups:AllocationGroup[]):AllocationGroup[]{const blocks=new Map<string,AllocationGroup[]>();for(const g of groups){const k=g.normalizedLegalEntity.key;const items=blocks.get(k)??[];items.push(g);blocks.set(k,items);}return[...blocks.values()].flat();}
function setFormula(ws:ExcelJS.Worksheet,cell:string,formula:string,result:number){ws.getCell(cell).value={formula,result};}
function metadataSheet(wb:ExcelJS.Workbook,source:ImportedSource){const old=wb.getWorksheet('_分摊元数据');if(old)wb.removeWorksheet(old.id);const s=wb.addWorksheet('_分摊元数据',{state:'veryHidden'});const data=JSON.stringify({sourceId:source.id,allowBlankDepartment:source.allowBlankDepartment === true,sourceReference:source.sourceReference,importAttestation:source.importAttestation,balanceFingerprints:source.balanceFingerprints,originalCents:source.originalCents,history:source.history,rows:Object.fromEntries(source.rows.map(r=>[String(r.sheetRow),{id:r.id,originalFile:r.originalFile,originalRow:r.originalRow,departmentResolution:r.departmentResolution}]))});for(let i=0;i<data.length;i+=30000)s.addRow([data.slice(i,i+30000)]);}
function clone<T>(v:T):T{return JSON.parse(JSON.stringify(v));}
function topLedger(ws:ExcelJS.Worksheet,source:ImportedSource,remaining:number){let c=9;for(const h of source.history){ws.getCell(1,c).value=h.product;ws.getCell(2,c).value=h.usedCents/100;c++;}const last=String.fromCharCode(64+Math.min(c-1,26));const refs=source.history.map((_,i)=>`${ws.getColumn(i+9).letter}2`);setFormula(ws,'E2',`SUM(${ws.getColumn(source.columns.amount).letter}${source.headerRow+1}:${ws.getColumn(source.columns.amount).letter}${Math.max(source.headerRow+1,ws.rowCount)})`,remaining/100);ws.getCell('D2').value=source.originalCents/100;setFormula(ws,'C2',`SUM(E2${refs.length?','+refs.join(','):''})`,source.originalCents/100);setFormula(ws,'G2','D2-C2',0);void last;}

export async function generateBatchFiles(args:{batchId:string;batchCreatedAt:string;product:string;priceCents:number;quantity:number;sources:ImportedSource[];plan:AllocationPlan;taxes:TaxRecord[];taxOverrides?:TaxOverride[];sourceBuffers:Record<string,Uint8Array>;template:Uint8Array;productHistory:ProductHistory[]}):Promise<{files:GeneratedFile[];nextSources:ImportedSource[];invoiceRows:any[];taxPending:number;folderName:string}> {
  const {batchId,batchCreatedAt,product,priceCents,quantity,sources,plan,taxes}=args;const files:GeneratedFile[]=[];const nextSources:ImportedSource[]=[];const ordered=invoiceOrder(plan.groups);const invoiceRows=ordered.map((g,i)=>({...g,targetRow:i+4,tax:taxDecision(g.legalEntity,taxes,args.taxOverrides??[],batchId,batchCreatedAt)}));
  async function add(name:string,role:string,wb:ExcelJS.Workbook,sourceId?:string){wb.calcProperties.fullCalcOnLoad=true;const bytes=new Uint8Array(await wb.xlsx.writeBuffer());files.push({name,role,bytes,sha256:await digest(bytes),sourceId});}
  const invoice=await load(args.template);const inv=invoice.worksheets[0];if(!inv)throw new Error('开票模板没有工作表。');
  const targetAliases:Record<string,string[]>={applicant:['申领人'],department:['申领部门'],useCenter:['使用中心','使用部门'],costCenter:['成本中心'],used:['部门使用金额','部门使用金额（元）'],legalEntity:['费用承担法律主体'],tax:['开票明细'],purpose:['申领用途'],price:['单价','单价（元）'],quantity:['数量'],total:['总计金额','总计金额（元）','合计金额']};const target:Record<string,number>={};
  inv.getRow(3).eachCell((cell,c)=>{const label=text(cell).replace(/\s/g,'');for(const[k,aliases]of Object.entries(targetAliases))if(aliases.includes(label))target[k]=c;});
  const missing=Object.keys(targetAliases).filter(k=>!target[k]);if(missing.length)throw new Error(`模板第3行缺少必要表头：${missing.map(k=>targetAliases[k][0]).join('、')}。`);
  const width=Math.max(inv.columnCount,...Object.values(target));const styleRow=inv.getRow(4);const styles=Array.from({length:width},(_,i)=>clone(styleRow.getCell(i+1).style));const rowHeight=styleRow.height??24;
  const last=Math.max(inv.rowCount,3+invoiceRows.length);for(let r=4;r<=last;r++)for(const c of Object.values(target))inv.getCell(r,c).value=null;
  for(const [i,row]of invoiceRows.entries()){const r=i+4;const values:Record<string,ExcelJS.CellValue>={applicant:row.applicant,department:row.department,useCenter:row.useCenter,costCenter:row.costCenter,used:row.usedCents/100,legalEntity:row.legalEntity,tax:row.tax.text,purpose:row.purpose,price:priceCents/100,quantity:row.quantity,total:row.usedCents/100};for(const[k,c]of Object.entries(target)){const cell=inv.getCell(r,c);cell.style=clone(styles[c-1]);cell.value=values[k];cell.alignment={...cell.alignment,vertical:'middle',wrapText:true};}inv.getRow(r).height=Math.max(rowHeight,row.tax.mode==='normal'?112:36);if(row.tax.mode==='pending')inv.getCell(r,target.tax).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFF0000'}};}
  const qCol=inv.getColumn(target.quantity).letter,tCol=inv.getColumn(target.total).letter;inv.getCell(2,target.price).value=priceCents/100;setFormula(inv,`${qCol}2`,`SUM(${qCol}4:${qCol}${3+invoiceRows.length})`,quantity);setFormula(inv,`${tCol}2`,`SUM(${tCol}4:${tCol}${3+invoiceRows.length})`,plan.totalCents/100);
  await add(`01_开票单_${safeName(product)}_${plan.totalCents/100}元.xlsx`,'invoice',invoice);
  let ordinal=2;
  for(const source of sources){const summary=plan.sourceSummaries.find(s=>s.sourceId===source.id)!;const usage=new Map(plan.sourceUses.filter(u=>u.sourceId===source.id).map(u=>[u.rowId,u]));const nextHistory=[...source.history,{batchId,product,usedCents:summary.usedCents}];
    let remainingSource:ImportedSource|undefined;
    for(const mode of ['marked','remaining']as const){const wb=await load(args.sourceBuffers[source.id]);let ws=wb.getWorksheet(source.sheetName)!;const byPhysical=new Map(source.rows.map(r=>[r.sheetRow,r]));const rebuilt:{raw:unknown[];styles:Partial<ExcelJS.Style>[];height:number|undefined;source?:ImportedRow;used:boolean;amount?:number}[]=[];
      for(let r=source.headerRow+1;r<=ws.rowCount;r++){const original=byPhysical.get(r);const old=ws.getRow(r);const raw=Array.from({length:Math.max(8,ws.columnCount)},(_,c)=>val(old.getCell(c+1))??null);const styles=raw.map((_,c)=>clone(old.getCell(c+1).style));const base={raw,styles,height:old.height};if(!original){rebuilt.push({...base,used:false});continue;}if(original.historicUsed){if(mode==='marked')rebuilt.push({...base,source:original,used:true,amount:original.amountCents});continue;}const u=usage.get(original.id);if(u&&mode==='marked')rebuilt.push({...base,source:original,used:true,amount:u.usedCents});const remainder=original.amountCents-(u?.usedCents??0);if(remainder>0)rebuilt.push({...base,source:original,used:false,amount:remainder});}
      const originalSheet=ws;const oldName=ws.name;const replacement=wb.addWorksheet('_rebuild_'+crypto.randomUUID().slice(0,8),{properties:clone(ws.properties),pageSetup:clone(ws.pageSetup),views:clone(ws.views)});replacement.columns=originalSheet.columns.map(c=>({width:c.width,hidden:c.hidden,outlineLevel:c.outlineLevel}));for(let r=1;r<=source.headerRow;r++){const from=originalSheet.getRow(r),to=replacement.getRow(r);to.height=from.height;from.eachCell({includeEmpty:true},(c,i)=>{to.getCell(i).value=clone(c.value);to.getCell(i).style=clone(c.style);});}for(const range of originalSheet.model.merges??[]){const end=range.split(':').pop()??'';const row=Number(end.replace(/[A-Z]/g,''));if(row<=source.headerRow)replacement.mergeCells(range);}wb.removeWorksheet(originalSheet.id);replacement.name=oldName;ws=replacement;const nextRows:ImportedRow[]=[];const exportedRows:ImportedRow[]=[];const availableRowRefs:string[]=[];
      for(const item of rebuilt){const row=ws.addRow(item.raw as ExcelJS.CellValue[]);if(item.height!==undefined)row.height=item.height;item.styles.forEach((s,i)=>row.getCell(i+1).style=clone(s));if(item.source){const cell=row.getCell(source.columns.amount);const assignment=plan.departmentAssignments.find(a=>a.sourceId===item.source!.sourceId&&a.rowId===item.source!.id);const resolution=assignment?{department:assignment.department,useCenter:assignment.useCenter}:item.source.departmentResolution;cell.value=item.amount!/100;cell.font={...cell.font,color:{argb:item.used?'FFFF0000':'FF000000'}};exportedRows.push({...item.source,id:item.used?`${item.source.id}:used:${batchId}:${row.number}`:item.source.id,sheetRow:row.number,amountCents:item.amount!,historicUsed:item.used,departmentResolution:resolution});if(!item.used){availableRowRefs.push(cell.address);nextRows.push({...item.source,sheetRow:row.number,amountCents:item.amount!,historicUsed:false,departmentResolution:resolution});}}}
      const next:ImportedSource={...source,history:nextHistory,rows:nextRows};topLedger(ws,next,summary.remainingCents);if(mode==='marked')setFormula(ws,'E2',availableRowRefs.length?`SUM(${availableRowRefs.join(',')})`:'0',summary.remainingCents/100);
      ws.autoFilter={from:{row:source.headerRow,column:1},to:{row:Math.max(source.headerRow,ws.rowCount),column:8}};metadataSheet(wb,{...next,rows:exportedRows});
      const label=`${ordinal.toString().padStart(2,'0')}_第${source.priority}金额表_${mode==='marked'?'已标红':'剩余'}.xlsx`;await add(label,`${source.id}_${mode}`,wb,source.id);ordinal++;if(mode==='remaining')remainingSource=next;
    }
    const nextFingerprint=await sourceBalanceFingerprint(remainingSource!);
    const currentFingerprint=await sourceBalanceFingerprint(source);
    nextSources.push({...remainingSource!,balanceFingerprints:[...new Set([...(source.balanceFingerprints??[]),currentFingerprint,nextFingerprint])]});
  }
  const audit=new ExcelJS.Workbook();const totals=audit.addWorksheet('本批核对');totals.addRows([['核对项目','结果'],['批次',batchId],['商品',product],['单价（元）',priceCents/100],['数量',quantity],['本批金额（元）',plan.totalCents/100],['使用前金额（元）',plan.availableCents/100],['使用后余额（元）',plan.remainingCents/100],['计算方式',plan.proof.method],['双agent报告位置','运行记录/agent-1.json、运行记录/agent-2.json；正式完成以外部最终哈希核验报告为准']]);
  const groupSheet=audit.addWorksheet('分组与税务');groupSheet.addRow(['开票行','申领人','申领部门','使用中心','成本中心','法律主体','用途','组原额（元）','使用（元）','数量','组余款（元）','税务状态','税务说明']);for(const g of invoiceRows)groupSheet.addRow([g.targetRow,g.applicant,g.department,g.useCenter,g.costCenter,g.legalEntity,g.purpose,g.availableCents/100,g.usedCents/100,g.quantity,g.remainderCents/100,g.tax.mode,g.tax.reason]);
  const trace=audit.addWorksheet('源行使用与拆分');trace.addRow(['来源','原文件','原行号','记录身份','原额（元）','已用（元）','余款（元）','使用状态']);for(const u of plan.sourceUses)trace.addRow([u.sourceId,u.originalFile,u.originalRow,u.rowId,u.originalCents/100,u.usedCents/100,u.remainingCents/100,u.status]);
  const ledger=audit.addWorksheet('逐源对账');ledger.addRow(['来源','原额','历史已用','本批前可用','本批已用','剩余','累计已用','差额']);for(const s of plan.sourceSummaries)ledger.addRow([s.name,s.originalCents/100,s.previousUsedCents/100,s.beforeCents/100,s.usedCents/100,s.remainingCents/100,s.cumulativeUsedCents/100,s.differenceCents/100]);
  const exclusion=audit.addWorksheet('未使用异常');exclusion.addRow(['来源','原行','记录身份','金额','原因']);for(const e of plan.exclusions)exclusion.addRow([e.sourceId,e.originalRow,e.rowId,e.amountCents/100,e.reason]);
  for(const ws of audit.worksheets){ws.views=[{state:'frozen',ySplit:1}];ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF253B65'}};ws.columns.forEach(c=>c.width=22);ws.eachRow(row=>row.eachCell(c=>c.alignment={vertical:'top',wrapText:true}));}
  await add(`${ordinal.toString().padStart(2,'0')}_分摊核对记录.xlsx`,'audit',audit);
  const lineage=[...args.productHistory,{batchId,product}].map(x=>safeName(x.product)).join('／');const stamp=new Date().toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}).replace(/[-: ]/g,'');const folderName=`${stamp}_${safeName(product)}_${plan.totalCents/100}元（${lineage}）`;
  if(folderName.length>220)throw new Error('累计商品名称已超出文件夹安全长度，请先确认缩短命名方案。');
  return{files,nextSources,invoiceRows,taxPending:invoiceRows.filter(g=>g.tax.mode==='pending').length,folderName};
}
export function safeName(name:string):string{return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/,'').slice(0,100);}
export async function zipFiles(folder:string,files:{name:string;bytes:Uint8Array}[],extras:Record<string,string|Uint8Array>={}):Promise<Uint8Array>{const zip=new JSZip();for(const f of files)zip.file(`${folder}/${f.name}`,f.bytes);for(const[k,v]of Object.entries(extras))zip.file(`${folder}/${k}`,v);return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});}
