import ExcelJS from 'exceljs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const dir=resolve('work/browser-fixtures');await mkdir(dir,{recursive:true});
for(const [index,amount,entity]of [[1,10.5,'测试公司（L100001）'],[2,389.5,'L100001 测试公司']]){
 const w=new ExcelJS.Workbook(),s=w.addWorksheet('工作表1');s.getCell('D2').value=amount;s.getCell('E2').value={formula:'SUM(E4:E4)',result:amount};s.getCell('C2').value={formula:'E2',result:amount};s.getCell('G2').value={formula:'D2-C2',result:0};s.getRow(3).values=['申领人','申领部门','使用部门','成本中心','成本','费用承担法律主体','','申领用途'];s.getRow(4).values=['测试申领人','测试部门','测试使用中心','TEST-001',amount,entity,'','测试用途'];s.columns.forEach(c=>c.width=20);await w.xlsx.writeFile(resolve(dir,`source${index}.xlsx`));
}
const t=new ExcelJS.Workbook(),ts=t.addWorksheet('税务记录');ts.addRow(['法律主体编码','实际主体名称','当前主体类型','社会统一信用代码','注册地址','开户行','银行基本户账号']);ts.addRow(['L100001','测试公司','一般纳税人-一般征收','000000000000000001','测试注册地址','测试开户银行','000012345678901234']);await t.xlsx.writeFile(resolve(dir,'tax.xlsx'));
const w=new ExcelJS.Workbook(),s=w.addWorksheet('开票单');s.getCell('A2').value='EP_TEST_KEEP';s.getRow(3).values=['申领人','申领部门','使用中心','成本中心','部门使用金额','费用承担法律主体','开票明细','申领用途','单价','数量','总计金额'];s.getRow(4).values=Array(11).fill('');s.columns.forEach(c=>c.width=22);s.getColumn(7).width=42;s.getRow(4).height=32;s.getRow(4).eachCell(c=>{c.font={name:'等线',size:11};c.alignment={wrapText:true};});await w.xlsx.writeFile(resolve(dir,'template.xlsx'));
console.log(JSON.stringify({directory:dir,sourceTotalCents:40000,priceCents:3300,quantity:3,invoiceTotalCents:9900,remainingCents:30100}));
