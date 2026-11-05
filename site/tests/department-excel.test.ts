import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { build } from 'esbuild';
// @ts-ignore TypeScript runner
import { planAllocation } from '../app/lib/allocation.ts';

const work=fileURLToPath(new URL('../work/department-independent-excel/',import.meta.url));await mkdir(work,{recursive:true});
const entry=fileURLToPath(new URL('../app/lib/spreadsheets.ts',import.meta.url));
const bundle=path.join(work,'io.mjs');await build({entryPoints:[entry],outfile:bundle,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
const io=await import(pathToFileURL(bundle).href);
const headers=['申领人','申领部门','使用部门','成本中心','成本','费用承担法律主体','备注','申领用途'];
const invoiceHeaders=['申领人','申领部门','使用部门','成本中心','部门使用金额','费用承担法律主体','开票明细','申领用途','单价','数量','总计金额'];
const entity='合成公司（L100001）';
async function bytes(wb:ExcelJS.Workbook){return new Uint8Array(await wb.xlsx.writeBuffer());}
async function open(buffer:Uint8Array){const wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer as never);return wb;}
function scalar(cell:ExcelJS.Cell){return cell.type===ExcelJS.ValueType.Formula?cell.result:cell.value;}
async function input(name:string,priority:number,rows:(string|number)[][]){
 const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('金额来源');ws.getRow(3).values=headers;
 rows.forEach((values,i)=>ws.getRow(i+4).values=values);const total=rows.reduce((n,r)=>n+Number(r[4]),0);ws.getCell('D2').value=total;ws.getCell('E2').value=total;
 const data=await bytes(wb),source=await io.parseSource(data,name,priority);return {data,source};
}
async function invoiceTemplate(){const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('开票');ws.getCell('A1').value='EP-SYNTHETIC';ws.getRow(3).values=invoiceHeaders;return bytes(wb);}
const makeRow=(amount:number,department:string,useCenter:string)=>(['员工甲',department,useCenter,'成本甲',amount,entity,'合成备注','测试用途']);
test('generated workbook merges only exact nonblank departments and reconciles FIFO across sources',async()=>{
 const a=await input('合成第一表.xlsx',1,[makeRow(105,'甲部门','甲中心')]);const b=await input('合成第二表.xlsx',2,[makeRow(396,'甲部门','甲中心')]);
 const sources=[a.source,b.source];const plan=planAllocation(sources,10000,2);
 const generated=await io.generateBatchFiles({batchId:'synthetic',batchCreatedAt:'2026-11-05T00:00:00.000Z',product:'合成商品',priceCents:10000,quantity:2,sources,plan,taxes:[],sourceBuffers:{[a.source.id]:a.data,[b.source.id]:b.data},template:await invoiceTemplate(),productHistory:[]});
 assert.equal(generated.files.length,6);const invoice=(await open(generated.files.find((f:any)=>f.role==='invoice').bytes)).worksheets[0];
 assert.equal(scalar(invoice.getCell('A1')),'EP-SYNTHETIC');assert.equal(scalar(invoice.getCell('B4')),'甲部门');assert.equal(scalar(invoice.getCell('C4')),'甲中心');
 assert.equal(scalar(invoice.getCell('E4')),200);assert.equal(scalar(invoice.getCell('J4')),2);assert.equal(scalar(invoice.getCell('K4')),200);
 const markedA=(await open(generated.files.find((f:any)=>f.role===`${a.source.id}_marked`).bytes)).worksheets[0];
 const markedB=(await open(generated.files.find((f:any)=>f.role===`${b.source.id}_marked`).bytes)).worksheets[0];
 const remainB=(await open(generated.files.find((f:any)=>f.role===`${b.source.id}_remaining`).bytes)).worksheets[0];
 assert.equal(scalar(markedA.getCell('E4')),105);assert.equal(scalar(markedA.getCell('B4')),'甲部门');assert.equal(scalar(markedA.getCell('C4')),'甲中心');
 assert.equal(markedA.getCell('E4').font.color?.argb?.slice(-6),'FF0000');assert.equal(scalar(markedB.getCell('E4')),95);assert.equal(scalar(markedB.getCell('E5')),301);
 assert.equal(scalar(markedB.getCell('B4')),'甲部门');assert.equal(scalar(markedB.getCell('C4')),'甲中心');assert.equal(scalar(markedB.getCell('B5')),'甲部门');assert.equal(scalar(markedB.getCell('C5')),'甲中心');
 assert.equal(scalar(remainB.getCell('E4')),301);assert.equal(scalar(remainB.getCell('B4')),'甲部门');assert.equal(scalar(remainB.getCell('C4')),'甲中心');
 assert.equal(scalar(markedA.getCell('I2')),105);assert.equal(scalar(markedB.getCell('I2')),95);assert.equal(scalar(remainB.getCell('I2')),95);
 assert.equal(scalar(markedA.getCell('D2')),105);assert.equal(scalar(markedA.getCell('E2')),0);assert.equal(scalar(remainB.getCell('D2')),396);assert.equal(scalar(remainB.getCell('E2')),301);
});
test('blank department row stays isolated and its invoice fields remain blank',async()=>{
 const a=await input('合成.xlsx',1,[makeRow(100,'',''),makeRow(301,'甲部门','甲中心')]);const sources=[a.source];const plan=planAllocation(sources,10000,1);
 const generated=await io.generateBatchFiles({batchId:'synthetic2',batchCreatedAt:'2026-11-05T00:00:00.000Z',product:'合成商品',priceCents:10000,quantity:1,sources,plan,taxes:[],sourceBuffers:{[a.source.id]:a.data},template:await invoiceTemplate(),productHistory:[]});
 const invoice=(await open(generated.files.find((f:any)=>f.role==='invoice').bytes)).worksheets[0];assert.equal(scalar(invoice.getCell('B4')),'');assert.equal(scalar(invoice.getCell('C4')),'');
 const remain=(await open(generated.files.find((f:any)=>f.role===`${a.source.id}_remaining`).bytes)).worksheets[0];assert.equal(scalar(remain.getCell('E4')),301);assert.equal(scalar(remain.getCell('B4')),'甲部门');assert.equal(scalar(remain.getCell('C4')),'甲中心');
});
