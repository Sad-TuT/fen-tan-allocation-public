import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore TypeScript runner
import { planAllocation,validateAllocationPlan } from '../app/lib/allocation.ts';

type Row = {id:string;sourceId:string;originalFile:string;originalRow:number;applicant:string;department:string;useCenter:string;costCenter:string;legalEntity:string;purpose:string;amountCents:number};
let seq=0;
function row(amountCents:number, changes:Partial<Row>={}):Row {
 const n=++seq;return {id:'r'+n,sourceId:'s1',originalFile:'synthetic.xlsx',originalRow:n+3,applicant:'申请人甲',department:'',useCenter:'',costCenter:'成本中心甲',legalEntity:'示例公司（L100001）',purpose:'用途甲',amountCents,...changes};
}
function source(id:string,priority:number,rows:Row[]) {
 const items=rows.map(x=>({...x,sourceId:id}));return {id,name:id,priority,originalCents:items.reduce((s,r)=>s+r.amountCents,0),history:[],rows:items};
}
const key=(row:any)=>JSON.stringify([row.applicant,row.costCenter,row.legalEntity,row.purpose]);
const filled=(v:string)=>typeof v==='string'&&v.trim().length>0;
function independentlyVerify(sources:any[],price:number,quantity:number,plan:any){
 const issues:string[]=[], seen=new Set<string>(),perSource=new Map(sources.map(s=>[s.id,0]));let sum=0;
 const all=sources.flatMap(s=>s.rows.filter((r:any)=>!r.historicUsed&&r.amountCents>0));
 for(const group of plan.groups){
  const members=all.filter((r:any)=>key(r)===key(group)&&(!filled(r.department)||!filled(group.department)||r.department===group.department)&&(!filled(r.useCenter)||!filled(group.useCenter)||r.useCenter===group.useCenter));
  for(const field of ['department','useCenter'] as const){const vals=[...new Set(members.map((r:any)=>r[field]).filter(filled))];if(vals.length>1)issues.push('conflict '+field);const expected=vals.length===1?vals[0]:'';if(group[field]!==expected)issues.push('incorrect display '+field);}
  const available=members.reduce((n:number,r:any)=>n+r.amountCents,0);if(group.availableCents!==available)issues.push('unaccounted eligible source row');
  if(group.usedCents!==price*group.quantity)issues.push('price mismatch');const rem=available-group.usedCents;if(!(rem===0||(rem>=30000&&rem%100===0))||group.remainderCents!==rem)issues.push('bad full-group remainder');
  for(const use of group.sourceUses){const id=use.sourceId+'|'+use.rowId;if(seen.has(id))issues.push('duplicate row');seen.add(id);const src=members.find((r:any)=>r.id===use.rowId&&r.sourceId===use.sourceId);if(!src||src.amountCents!==use.originalCents||use.usedCents+use.remainingCents!==src.amountCents)issues.push('bad use or source trace');perSource.set(use.sourceId,(perSource.get(use.sourceId)??0)+use.usedCents);}
  if(group.sourceUses.reduce((n:number,u:any)=>n+u.usedCents,0)!==group.usedCents)issues.push('inconsistent group usage');sum+=group.usedCents;
 }
 if(sum!==price*quantity)issues.push('bad overall total');
 for(const s of sources){const summary=plan.sourceSummaries.find((x:any)=>x.sourceId===s.id);const expected=perSource.get(s.id)??0;if(!summary||summary.usedCents!==expected||summary.remainingCents!==s.originalCents-expected||summary.originalCents!==summary.remainingCents+summary.cumulativeUsedCents)issues.push('source ledger mismatch');}
 return issues;
}

test('blank fields reconcile to unique values even when only the blank row was used',()=>{
 const sources=[source('s1',1,[row(10000),row(30100,{department:'部门甲',useCenter:'中心甲'})])];
 const plan=planAllocation(sources,10000,1);assert.deepEqual(independentlyVerify(sources,10000,1,plan),[]);
 assert.equal(plan.groups.length,1);assert.equal(plan.groups[0].department,'部门甲');assert.equal(plan.groups[0].useCenter,'中心甲');assert.equal(plan.groups[0].remainderCents,30100);
 const bad=structuredClone(plan);bad.groups[0].department='';assert.ok(independentlyVerify(sources,10000,1,bad).some(x=>x.includes('display')));
});
test('a 300 yuan whole-group remainder is allowed even when unused compatible amount is present',()=>{
 const sources=[source('s1',1,[row(10000),row(30000,{department:'部门甲'})])];
 const plan=planAllocation(sources,10000,4);assert.equal(plan.groups[0].remainderCents,0);
 const boundary=source('s1',1,[row(40000,{department:'部门甲'})]);
 assert.equal(planAllocation([boundary],10000,1).groups[0].remainderCents,30000);
 const below=source('s1',1,[row(39999,{department:'部门甲'})]);
 assert.throws(()=>planAllocation([below],10000,1));
});
test('cross-source compatible rows preserve priority, whole-group remainder and original fields',()=>{
 const sources=[source('s1',1,[row(10500)]),source('s2',2,[row(39600,{department:'部门甲',useCenter:'中心甲'})])];
 const before=JSON.stringify(sources);const plan=planAllocation(sources,10000,2);assert.deepEqual(independentlyVerify(sources,10000,2,plan),[]);
 assert.equal(plan.sourceSummaries[0].usedCents,10500);assert.equal(plan.sourceSummaries[1].usedCents,9500);assert.equal(plan.groups[0].remainderCents,30100);assert.equal(JSON.stringify(sources),before);
});
test('first-source priority overrides using fewer groups',()=>{
 const sources=[source('s1',1,[row(10000,{applicant:'人员甲'})]),source('s2',2,[row(20000,{applicant:'人员乙'}),row(10000,{applicant:'人员丙'})])];
 const plan=planAllocation(sources,10000,2);assert.deepEqual(independentlyVerify(sources,10000,2,plan),[]);
 assert.equal(plan.sourceSummaries[0].usedCents,10000);assert.equal(plan.groups.length,2);
});
test('differing nonblank department values cannot share a group',()=>{
 const sources=[source('s1',1,[row(10000,{department:'部门甲'}),row(10000,{department:'部门乙'})])];
 const plan=planAllocation(sources,10000,2);assert.equal(plan.groups.length,2);assert.deepEqual(independentlyVerify(sources,10000,2,plan),[]);
});
test('blank row with incompatible alternatives must stop as ambiguity, not financial unsatisfiability',()=>{
 const sources=[source('s1',1,[row(10000,{department:'部门甲'}),row(10000),row(10000,{department:'部门乙'})])];
 assert.throws(()=>planAllocation(sources,10000,1),(e:any)=>e.code!=='UNSATISFIABLE'&&/歧义|确认|选择|归属/.test(e.message));
});
test('same applicant requirement prevents combining different people',()=>{
 const sources=[source('s1',1,[row(5000),row(5000,{applicant:'申请人乙'})])];
 assert.throws(()=>planAllocation(sources,10000,1));
});
test('cross-field conflicts with a jointly ambiguous blank record stop instead of merging both groups',()=>{
 const sources=[source('s1',1,[row(10000,{department:'部门甲',useCenter:'中心甲'}),row(10000),row(10000,{department:'部门乙',useCenter:'中心乙'})])];
 assert.throws(()=>planAllocation(sources,10000,1),(e:any)=>e.code!=='UNSATISFIABLE'&&/歧义|确认|选择|归属/.test(e.message));
});
test('confirmed cross-field assignment keeps all rows in exactly one conflict-free group regardless of source row enumeration',()=>{
 for(const chosen of ['部门甲','部门乙'])for(const reversed of [false,true]){
  const ambiguous=row(10000,{useCenter:'中心甲'}),anchorA=row(30100,{department:'部门甲'}),anchorB=row(30100,{department:'部门乙',useCenter:'中心甲'});
  const others=reversed?[anchorB,anchorA]:[anchorA,anchorB];const sources=[source('s1',1,[ambiguous]),source('s2',2,others)];
  let options:any[]=[];try{planAllocation(sources,10000,1);}catch(e:any){assert.equal(e.code,'AMBIGUOUS_ASSIGNMENT');options=e.ambiguities;}
  assert.equal(options.length,1);assert.equal(options[0].rowId,ambiguous.id);
  assert.deepEqual(new Set(options[0].candidates.map((x:any)=>x.department)),new Set(['部门甲','部门乙']));
  const assignments=[{sourceId:'s1',rowId:ambiguous.id,department:chosen,useCenter:'中心甲'}];
  const plan=planAllocation(sources,10000,1,{},assignments);assert.equal(validateAllocationPlan(sources,10000,1,plan).valid,true);
  const membership=plan.groupMembership.flatMap(x=>x.rows.map(r=>r.sourceId+'|'+r.rowId));
  assert.equal(membership.length,3);assert.equal(new Set(membership).size,3);
  assert.equal(plan.sourceSummaries[0].usedCents,10000);assert.equal(plan.groups[0].department,chosen);assert.equal(plan.groups[0].useCenter,'中心甲');assert.equal(plan.groups[0].remainderCents,30100);
  const tampered=structuredClone(plan);tampered.groupMembership[0].rows.pop();assert.equal(validateAllocationPlan(sources,10000,1,tampered).valid,false);
  assert.throws(()=>planAllocation(sources,10000,1,{},[{...assignments[0],department:'不存在的部门'}]));
  assert.throws(()=>planAllocation(sources,10000,1,{},[assignments[0],assignments[0]]));
 }
});
test('independent clique oracle detects all ambiguities across 729 three-row department combinations',()=>{
 const combos=['','部门甲','部门乙'].flatMap(department=>['','中心甲','中心乙'].map(useCenter=>({department,useCenter})));
 const can=(a:any,b:any)=>['department','useCenter'].every(k=>!filled(a[k])||!filled(b[k])||a[k]===b[k]);
 let checked=0;
 for(const x of combos)for(const y of combos)for(const z of combos){
  const rows=[row(10000,x),row(10000,y),row(10000,z)];const expected=new Set<string>();
  for(let i=0;i<rows.length;i++){
   const signatures=new Set<string>();
   for(let mask=1;mask<(1<<rows.length);mask++){
    if(!(mask&(1<<i)))continue;const included=rows.filter((_,j)=>mask&(1<<j));
    if(!included.every((a,j)=>included.every((b,k)=>j===k||can(a,b))))continue;
    if(rows.some((a,j)=>!(mask&(1<<j))&&included.every(b=>can(a,b))))continue;
    const dep=included.find(r=>filled(r.department))?.department??'';const center=included.find(r=>filled(r.useCenter))?.useCenter??'';
    signatures.add(JSON.stringify([dep,center]));
   }
   if(signatures.size>1)expected.add(rows[i].id);
  }
  let error:any;try{planAllocation([source('s1',1,rows)],10000,1);}catch(e){error=e;}
  if(expected.size){assert.equal(error?.code,'AMBIGUOUS_ASSIGNMENT',`states=${JSON.stringify([x,y,z])} unexpected=${error?.code??'no error'}`);assert.deepEqual(new Set(error.ambiguities.map((a:any)=>a.rowId)),expected);}
  else assert.notEqual(error?.code,'AMBIGUOUS_ASSIGNMENT');
  checked++;
 }
 assert.equal(checked,729);
});
test('confirmed assignment may retain an empty department when another conflicting center has nonempty department',()=>{
 for(const [d,c] of [['','中心甲'],['部门甲','中心乙']]){
  const a=row(10000),b=row(30100,{useCenter:'中心甲'}),cRow=row(30100,{department:'部门甲',useCenter:'中心乙'});
  const sources=[source('s1',1,[a]),source('s2',2,[b,cRow])];let candidates:any[]=[];
  try{planAllocation(sources,10000,1);}catch(e:any){assert.equal(e.code,'AMBIGUOUS_ASSIGNMENT');candidates=e.ambiguities[0].candidates;}
  assert.ok(candidates.some((v:any)=>v.department===d&&v.useCenter===c));
  const plan=planAllocation(sources,10000,1,{},[{sourceId:'s1',rowId:a.id,department:d,useCenter:c}]);
  assert.equal(plan.groups[0].department,d);assert.equal(plan.groups[0].useCenter,c);assert.equal(plan.groups[0].remainderCents,30100);
  assert.equal(plan.sourceSummaries[0].usedCents,10000);assert.equal(validateAllocationPlan(sources,10000,1,plan).valid,true);
 }
});
