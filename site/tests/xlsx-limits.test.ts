import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
const {validateXlsxArchive}=await import(new URL('../app/lib/xlsx-limits.ts',import.meta.url).href);

async function archive(extra:Record<string,Uint8Array|string>={}){
 const zip=new JSZip();zip.file('[Content_Types].xml','<Types/>');zip.file('xl/workbook.xml','<workbook/>');
 for(const [name,body] of Object.entries(extra))zip.file(name,body);
 return Buffer.from(await zip.generateAsync({type:'uint8array',compression:'DEFLATE'}));
}
function record(b:Buffer,name:string){
 const e=b.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));let p=b.readUInt32LE(e+16),end=e;
 while(p<end){assert.equal(b.readUInt32LE(p),0x02014b50);const n=b.readUInt16LE(p+28),x=b.readUInt16LE(p+30),c=b.readUInt16LE(p+32);if(b.subarray(p+46,p+46+n).toString()===name)return p;p+=46+n+x+c;}
 throw new Error('fixture entry missing');
}

test('accept ordinary generated Excel workbook without modifying input',async()=>{
 const w=new ExcelJS.Workbook();w.addWorksheet('表').addRow(['申领人','成本']);const b=Buffer.from(await w.xlsx.writeBuffer() as ArrayBuffer);const copy=Buffer.from(b);
 assert.doesNotThrow(()=>validateXlsxArchive(b));assert.deepEqual(b,copy);
});
test('reject invalid, truncated, encrypted, excessively many, or traversal archives',async()=>{
 assert.throws(()=>validateXlsxArchive(new Uint8Array([1,2,3])));
 const ok=await archive({'xl/worksheets/sheet1.xml':'<sheet/>'});assert.throws(()=>validateXlsxArchive(ok.subarray(0,ok.length-3)));
 const count=Buffer.from(ok),end=count.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));count.writeUInt16LE(1025,end+8);count.writeUInt16LE(1025,end+10);assert.throws(()=>validateXlsxArchive(count));
 const encrypted=Buffer.from(ok),p=record(encrypted,'xl/workbook.xml');encrypted.writeUInt16LE(encrypted.readUInt16LE(p+8)|1,p+8);assert.throws(()=>validateXlsxArchive(encrypted));
});
test('reject traversal path',async()=>{const b=await archive({'xl/../escape.xml':'x'});assert.throws(()=>validateXlsxArchive(b));});
test('reject compressed bombs and forged uncompressed length or CRC',async()=>{
 const bomb=await archive({'xl/worksheets/sheet1.xml':Buffer.alloc(8*1024*1024+1,65)});assert.ok(bomb.length<10*1024*1024);assert.throws(()=>validateXlsxArchive(bomb));
 const crafted=Buffer.from(bomb),p=record(crafted,'xl/worksheets/sheet1.xml'),local=crafted.readUInt32LE(p+42);crafted.writeUInt32LE(1,p+24);if(!(crafted.readUInt16LE(p+8)&8))crafted.writeUInt32LE(1,local+22);assert.throws(()=>validateXlsxArchive(crafted));
 const corrupt=await archive({'xl/worksheets/sheet1.xml':'abc'}),q=record(corrupt,'xl/worksheets/sheet1.xml'),l=corrupt.readUInt32LE(q+42);corrupt.writeUInt32LE(0,q+16);if(!(corrupt.readUInt16LE(q+8)&8))corrupt.writeUInt32LE(0,l+14);assert.throws(()=>validateXlsxArchive(corrupt));
});
test('reject total uncompressed size above the workbook cap',async()=>{
 const block=Buffer.alloc(7*1024*1024,65),extra:Record<string,Uint8Array>={};for(let i=0;i<5;i++)extra[`xl/worksheets/sheet${i}.xml`]=block;
 const bomb=await archive(extra);assert.ok(bomb.length<10*1024*1024);assert.throws(()=>validateXlsxArchive(bomb));
});
