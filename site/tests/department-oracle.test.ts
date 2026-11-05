import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore TypeScript runner
import {planAllocation} from '../app/lib/allocation.ts';
const variants=['','甲','乙'].flatMap(department=>['','X','Y'].map(useCenter=>({department,useCenter})));
const compatible=(a:any,b:any)=>['department','useCenter'].every(k=>!a[k]||!b[k]||a[k]===b[k]);
test('all 6561 four-row combinations report the exact independent ambiguity set',()=>{
 let checked=0;
 for(const a of variants)for(const b of variants)for(const c of variants)for(const d of variants){
  const combinations=[a,b,c,d];
  const rows=combinations.map((o,i)=>({id:`r${i}`,sourceId:'s',originalFile:'test.xlsx',originalRow:i+4,applicant:'人',department:o.department,useCenter:o.useCenter,costCenter:'成本',legalEntity:'合成（L100001）',purpose:'用途',amountCents:10000}));
  const expected=new Set<string>();
  for(let i=0;i<rows.length;i++){
   const groups=new Set<string>();
   for(let mask=1;mask<(1<<rows.length);mask++){
    if(!(mask&(1<<i)))continue;
    const members=rows.filter((_,j)=>mask&(1<<j));
    if(!members.every(m=>members.every(n=>compatible(m,n))))continue;
    if(rows.some((r,j)=>!(mask&(1<<j))&&members.every(m=>compatible(m,r))))continue;
    groups.add(JSON.stringify([members.find(r=>r.department)?.department??'',members.find(r=>r.useCenter)?.useCenter??'']));
   }
   if(groups.size>1)expected.add(rows[i].id);
  }
  const source={id:'s',name:'s',priority:1,originalCents:40000,history:[],rows};
  let error:any;try{planAllocation([source],10000,1);}catch(e){error=e;}
  if(expected.size){assert.equal(error?.code,'AMBIGUOUS_ASSIGNMENT',`case=${JSON.stringify(combinations)}`);assert.deepEqual(new Set(error.ambiguities.map((x:any)=>x.rowId)),expected,`case=${JSON.stringify(combinations)}`);}
  else assert.notEqual(error?.code,'AMBIGUOUS_ASSIGNMENT',`case=${JSON.stringify(combinations)}`);
  checked++;
 }
 assert.equal(checked,6561);
});
