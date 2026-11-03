import { crc32, inflateRawSync } from 'node:zlib';

// These limits bound the compressed input and the data ExcelJS will expand.
// XLSX is ZIP; inflated XML can be much larger than the uploaded file.
const MAX_ARCHIVE = 10 * 1024 * 1024;
const MAX_ENTRIES = 1024;
const MAX_ENTRY = 8 * 1024 * 1024;
const MAX_INFLATED = 32 * 1024 * 1024;
const bad = (): never => { throw new Error('Excel 文件格式无效或解压后超过处理限制，请检查文件或拆分后重试。'); };
const u16=(b:Buffer,p:number):number=>{if(p<0||p+2>b.length)return bad();return b.readUInt16LE(p);};
const u32=(b:Buffer,p:number):number=>{if(p<0||p+4>b.length)return bad();return b.readUInt32LE(p);};

/** Validate the entire ZIP before ExcelJS processes any member. This intentionally
 * rejects encrypted, multi-disk, ZIP64, overlapping and path-traversal archives. */
export function validateXlsxArchive(bytes:Uint8Array):void {
 if(!(bytes instanceof Uint8Array)||bytes.byteLength<22||bytes.byteLength>MAX_ARCHIVE)return bad();
 const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let end=-1;
 for(let p=b.length-22;p>=Math.max(0,b.length-22-0xffff);p--){
  if(u32(b,p)===0x06054b50&&p+22+u16(b,p+20)===b.length){end=p;break;}
 }
 if(end<0)return bad();
 // JSZip also uses the final signature; reject ambiguous signatures in comments.
 if(b.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]))!==end)return bad();
 const disk=u16(b,end+4),directoryDisk=u16(b,end+6),onDisk=u16(b,end+8),count=u16(b,end+10);
 const directoryLength=u32(b,end+12),directoryStart=u32(b,end+16);
 if(disk||directoryDisk||onDisk!==count||!count||count>MAX_ENTRIES||count===0xffff||directoryStart===0xffffffff||directoryLength===0xffffffff||directoryStart+directoryLength!==end)return bad();
 let pos=directoryStart,total=0;const names=new Set<string>(), ranges:Array<[number,number]>=[];
 for(let i=0;i<count;i++){
  if(pos+46>end||u32(b,pos)!==0x02014b50)return bad();
  const flags=u16(b,pos+8),method=u16(b,pos+10),crc=u32(b,pos+16),compressed=u32(b,pos+20),size=u32(b,pos+24);
  const nameLength=u16(b,pos+28),extraLength=u16(b,pos+30),commentLength=u16(b,pos+32),diskStart=u16(b,pos+34),local=u32(b,pos+42);
  const next=pos+46+nameLength+extraLength+commentLength;
  if(next>end||!nameLength||flags&0x41||diskStart||![0,8].includes(method)||compressed===0xffffffff||size===0xffffffff||local===0xffffffff||size>MAX_ENTRY||(total+=size)>MAX_INFLATED)return bad();
  const nameBytes=b.subarray(pos+46,pos+46+nameLength),name=nameBytes.toString('utf8');
  const pieces=name.split('/');if(name.includes('\0')||name.includes('\\')||name.startsWith('/')||pieces.some((s,j)=>s==='.'||s==='..'||(!s&&j!==pieces.length-1))||names.has(name))return bad();names.add(name);
  if(local+30>directoryStart||u32(b,local)!==0x04034b50||u16(b,local+6)!==flags||u16(b,local+8)!==method)return bad();
  const localNameLength=u16(b,local+26),localExtraLength=u16(b,local+28),dataStart=local+30+localNameLength+localExtraLength,dataEnd=dataStart+compressed;
  if(dataEnd>directoryStart||localNameLength!==nameLength||!b.subarray(local+30,local+30+localNameLength).equals(nameBytes))return bad();
  if(!(flags&8)&&(u32(b,local+14)!==crc||u32(b,local+18)!==compressed||u32(b,local+22)!==size))return bad();
  if(ranges.some(([a,z])=>local<z&&dataEnd>a))return bad();ranges.push([local,dataEnd]);
  let expanded:Buffer;
  try{
   const payload=b.subarray(dataStart,dataEnd);
   // The output limit is the advertised size + 1, capped at MAX_ENTRY + 1;
   // forged small size headers cannot cause unrestricted memory allocation.
   expanded=method===0?payload:inflateRawSync(payload,{maxOutputLength:Math.min(size+1,MAX_ENTRY+1)});
  }catch{return bad();}
  if(expanded.length!==size||crc32(expanded)!==crc)return bad();
  pos=next;
 }
 if(pos!==end||!names.has('[Content_Types].xml')||!names.has('xl/workbook.xml'))return bad();
}
