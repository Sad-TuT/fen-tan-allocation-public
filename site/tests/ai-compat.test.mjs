import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

globalThis.__aiTest = { calls: [], modelCalls: [], mode: 'success', version: 27, processing: null, processingError: null };
process.env.DEEPSEEK_API_KEY = ['synthetic', 'test', 'credential', 'mock', 'not', 'valid'].join('-').padEnd(24, 'x');
process.env.DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';
process.env.DEEPSEEK_MODEL = 'deepseek-flash';
globalThis.fetch = async (_url, request) => {
  if (globalThis.__aiTest.mode === 'provider-timeout') throw new Error('synthetic timeout');
  const body = JSON.parse(request.body);
  globalThis.__aiTest.latestPrompt = body;
  globalThis.__aiTest.modelCalls.push(body);
  const output = globalThis.__aiTest.mode === 'workspace'
    ? globalThis.__aiTest.workspaceOutput
    : globalThis.__aiTest.mode === 'workspace-precheck'
      ? {summary:'合成摘要检查', risks:[]}
      : globalThis.__aiTest.mode === 'precheck'
        ? {summary:'测试', risks:[]}
        : {
          product:'测试商品',
          unitPrice:globalThis.__aiTest.mode === 'array-price' ? [20] : '20',
          quantity:globalThis.__aiTest.mode === 'fractional' ? 1.7 : globalThis.__aiTest.mode === 'boolean' ? true : 3,
          ...(globalThis.__aiTest.mode === 'tampered-plan' ? {
            plan:{totalCents:1,groups:[{usedCents:1}]},
            simulation:{version:999,totalCents:1},
          } : {}),
        };
  return Response.json({choices: [{ message: { content: JSON.stringify(output) } }]});
};

const toModule = source => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/app/lib/ai.ts') && specifier === 'server-only') return toModule('export {};');
  if (context.parentURL?.endsWith('/app/lib/ai.ts') && specifier === './spreadsheets') return toModule('export const cents = value => Math.round(Number(value)*100);');
  if (context.parentURL?.endsWith('/app/lib/ai.ts') && specifier === './processing-jobs') return toModule(`
    export const getProcessingAIJobContext = async (id, userId, options) => {
      globalThis.__aiTest.processingRequest = { id, userId, options };
      if (globalThis.__aiTest.processingError) throw new Error(globalThis.__aiTest.processingError);
      return globalThis.__aiTest.processing;
    };
  `);
  return next(specifier, context);
}});
const { aiWorkspaceMessage, aiWorkspacePrecheck } = await import('../app/lib/ai.ts');

test('workspace chat keeps incomplete parameters as a draft instead of failing the turn', async () => {
  globalThis.__aiTest.mode = 'workspace';
  globalThis.__aiTest.workspaceOutput = {answer:'已识别商品，数量明确，还需单价。',draft:{product:'合成杯',quantity:4},missing:['price'],evidence:[]};
  const result = await aiWorkspaceMessage({message:'做一批合成杯，数量4',userId:'synthetic-user'});
  assert.deepEqual(result.draft,{product:'合成杯',quantity:4});
  assert.deepEqual(result.missing,['price']);
  assert.match(result.answer,/还需单价/);
  assert.equal(result.dataScope[0],'本轮没有载入本批资料或文件明细');
  assert.equal(globalThis.__aiTest.latestPrompt.model,'deepseek-flash');
  assert.deepEqual(globalThis.__aiTest.latestPrompt.response_format,{type:'json_object'});
});

test('workspace chat accepts only a bounded user and assistant history', async () => {
  globalThis.__aiTest.mode = 'workspace';
  globalThis.__aiTest.workspaceOutput = {answer:'合成回答',draft:null,missing:[],evidence:[]};
  const history = [
    {role:'system',content:'DO NOT SEND SYSTEM'},
    {role:'user',content:'第一条'},
    ...Array.from({length:10},(_,i)=>({role:i%2?'user':'assistant',content:`对话${i}`})),
  ];
  await aiWorkspaceMessage({message:'继续',userId:'synthetic-user',history});
  const messages = globalThis.__aiTest.latestPrompt.messages;
  assert.equal(messages.length,10); // system + last eight allowed turns + current user
  assert.doesNotMatch(JSON.stringify(messages),/DO NOT SEND SYSTEM|第一条/);
  assert.match(messages.at(-2).content,/对话9/);
});

test('only the explicitly selected preview page is sent, capped to 20 rows and 20 columns', async () => {
  globalThis.__aiTest.mode = 'workspace';
  globalThis.__aiTest.workspaceOutput = {answer:'查看了当前页数据。',draft:null,missing:[],evidence:[{label:'虚构位置',value:'不在预览中的秘密'}]};
  const rows = Array.from({length:24},(_,i)=>({sourceRow:i+1,values:Array.from({length:24},(_,j)=>i===23&&j===23?'不在预览中的秘密':`r${i+1}c${j+1}`)}));
  const result = await aiWorkspaceMessage({message:'这几行有什么规律？',userId:'synthetic-user',visibleData:{label:'合成预览',headers:Array.from({length:24},(_,i)=>`列${i+1}`),rows}});
  const encoded = JSON.stringify(globalThis.__aiTest.latestPrompt.messages.at(-1).content);
  assert.match(encoded,/r20c20/);
  assert.doesNotMatch(encoded,/不在预览中的秘密|r21c1|列21/);
  assert.equal(result.evidence[0].label,'合成预览 · 当前预览');
  assert.deepEqual(result.dataScope,['你勾选发送的“合成预览”预览，每次最多20行、20列']);
});

test('workspace context is loaded server-side for the signed-in owner and sent as a summary', async () => {
  globalThis.__aiTest.mode = 'workspace';
  globalThis.__aiTest.processing = {jobId:'12345678',status:'draft',revision:2,product:null,priceCents:null,quantity:null,sources:[{name:'合成资金',priority:1,availableCents:60000,usedCents:0,rowCount:2}],taxCount:1,hasTemplate:false,warnings:[]};
  globalThis.__aiTest.workspaceOutput = {answer:'有一个来源，模板尚未上传。',draft:null,missing:[],evidence:[]};
  const result = await aiWorkspaceMessage({message:'当前资料缺什么？',userId:'owner-user',jobId:'12345678'});
  assert.deepEqual(globalThis.__aiTest.processingRequest,{id:'12345678',userId:'owner-user',options:{includePrepared:true}});
  const prompt = globalThis.__aiTest.latestPrompt.messages.at(-1).content;
  const contextStart = prompt.indexOf('工作区资料(JSON)：\n') + '工作区资料(JSON)：\n'.length;
  const contextEnd = prompt.indexOf('\n\n本轮请求：\n', contextStart);
  const context = JSON.parse(prompt.slice(contextStart, contextEnd)).job;
  assert.equal(context.sources[0].availableYuan,'600.00');
  assert.equal(context.totalYuan,null);
  assert.deepEqual(result.evidence[0],{label:'本批资料',value:'1 个金额来源，税务记录 1 条，尚未上传开票模板'});
  globalThis.__aiTest.processing = null;
});

test('workspace context and precheck respect the job owner and report that no group rows were reviewed', async () => {
  globalThis.__aiTest.mode = 'workspace-precheck';
  globalThis.__aiTest.processing = {
    jobId:'12345678',status:'prepared',revision:3,product:'合成批次',quantity:10,taxCount:2,hasTemplate:true,warnings:[],
    prepared:{fileCount:4,taxPending:1,groupCount:12,totalCents:25000,sourceSummaries:[{sourceName:'来源A',usedCents:25000,remainingCents:0,differenceCents:0}],risksSummary:{missingDepartmentGroups:2,sourceDifferenceGroups:0}},
  };
  const result = await aiWorkspacePrecheck({jobId:'12345678',userId:'owner-user'});
  assert.equal(result.groupCount,12);
  assert.equal(result.groupsReviewed,0);
  assert.match(JSON.stringify(globalThis.__aiTest.latestPrompt.messages),/2 个独立组保留空白部门字段/);
  assert.doesNotMatch(JSON.stringify(globalThis.__aiTest.latestPrompt.messages),/申请人|开户行|税号/);
  assert.ok(result.risks.some((risk)=>risk.title==='独立组保留空白部门字段'));
  globalThis.__aiTest.processingError='无权限访问此本批。';
  const before=globalThis.__aiTest.modelCalls.length;
  await assert.rejects(()=>aiWorkspaceMessage({message:'查询',userId:'other-user',jobId:'12345678'}),/无权限访问此本批/);
  assert.equal(globalThis.__aiTest.modelCalls.length,before);
  globalThis.__aiTest.processingError=null;
  globalThis.__aiTest.processing=null;
});
