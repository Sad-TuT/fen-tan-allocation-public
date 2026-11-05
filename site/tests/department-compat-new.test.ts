import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore TypeScript runner
import {planAllocation, validateAllocationPlan} from '../app/lib/allocation.ts';
function make(rows: {department?:string;useCenter?:string;applicant?:string;amountCents?:number}[]) {
  const data=rows.map((v,i)=>({id:`r${i}`,sourceId:'s',originalFile:'test.xlsx',originalRow:i+4,applicant:'申请人',department:'',useCenter:'',costCenter:'CC',legalEntity:'示例公司(L100001)',purpose:'用途',amountCents:3300,...v}));
  return [{id:'s',name:'测试',priority:1,originalCents:data.reduce((a,r)=>a+r.amountCents,0),history:[],rows:data}];
}
test('both blank allowed, blank and one nonblank match, invoice values are nonblank, source unchanged',()=>{
 const sources=make([{department:'',useCenter:''},{department:'A',useCenter:'X'}]);const before=JSON.stringify(sources);
 const p=planAllocation(sources,3300,2);assert.equal(p.groups.length,1);assert.equal(p.groups[0].department,'A');assert.equal(p.groups[0].useCenter,'X');assert.equal(p.exclusions.length,0);assert.equal(validateAllocationPlan(sources,3300,2,p).valid,true);assert.equal(JSON.stringify(sources),before);
});
test('conflicting nonblank values never merge',()=>{
 const sources=make([{department:'A',useCenter:'X'},{department:'B',useCenter:'X'}]);const p=planAllocation(sources,3300,2);assert.equal(p.groups.length,2);assert.equal(validateAllocationPlan(sources,3300,2,p).valid,true);
});
test('blank row matching conflicting nonblank values must stop',()=>{
 const sources=make([{department:'A'},{department:''},{department:'B'}]);assert.throws(()=>planAllocation(sources,3300,1),/逐行确认归属/);
});
test('crossed department dimensions must stop instead of guessing',()=>{
 const sources=make([{department:'A',useCenter:'X'},{department:'A',useCenter:''},{department:'',useCenter:'Y'}]);assert.throws(()=>planAllocation(sources,3300,1),/逐行确认归属/);
});
test('explicit assignment is validated, frozen, and preserves original source fields',()=>{
 const sources=make([{department:'A'},{department:''},{department:'B'}]);const before=JSON.stringify(sources);
 const assigns=[{sourceId:'s',rowId:'r1',department:'A',useCenter:''}];
 const p=planAllocation(sources,3300,3,{},assigns);assert.equal(p.groups.length,2);assert.equal(p.groups.find(g=>g.department==='A')?.usedCents,6600);assert.equal(p.departmentAssignments.length,1);assert.equal(validateAllocationPlan(sources,3300,3,p).valid,true);assert.equal(JSON.stringify(sources),before);
 const bad=structuredClone(assigns);bad[0].department='伪造';assert.throws(()=>planAllocation(sources,3300,3,{},bad),/不属于当前合法候选/);
});
test('different applicants cannot be merged',()=>{
 const sources=make([{applicant:'甲'},{applicant:'乙'}]);assert.equal(planAllocation(sources,3300,2).groups.length,2);
});
test('old review cannot authorize a plan without rule version',()=>{
 const sources=make([{department:'A'}]);const p=planAllocation(sources,3300,1);delete (p as any).ruleVersion;assert.equal(validateAllocationPlan(sources,3300,1,p).valid,false);
});
test('tampering with unused group balance or group membership is rejected',()=>{
 const sources=make([{department:'A',amountCents:3300},{department:'',amountCents:30100},{department:'B',amountCents:3300}]);
 const assignments=[{sourceId:'s',rowId:'r1',department:'A',useCenter:''}];
 const p=planAllocation(sources,3300,1,{},assignments);assert.equal(validateAllocationPlan(sources,3300,1,p).valid,true);
 for(const change of ['delete','move','amount']){
   const bad=structuredClone(p);const a=bad.groupMembership.find(g=>g.rows.some(r=>r.rowId==='r1'))!,b=bad.groupMembership.find(g=>g!==a)!;const idx=a.rows.findIndex(r=>r.rowId==='r1');
   if(change==='delete')a.rows.splice(idx,1);else if(change==='move')b.rows.push(a.rows.splice(idx,1)[0]);else a.rows[idx].amountCents--;
   assert.equal(validateAllocationPlan(sources,3300,1,bad).valid,false,change);
 }
});
