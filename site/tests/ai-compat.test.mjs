import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

globalThis.__aiTest = { calls: [], mode: 'success', version: 27 };
process.env.DEEPSEEK_API_KEY = 'synthetic-test-key-not-for-external-use';
globalThis.fetch = async (_url, request) => {
  if (globalThis.__aiTest.mode === 'timeout') throw new Error('synthetic timeout');
  globalThis.__aiTest.latestPrompt = JSON.parse(request.body);
  const draft = {
    product: '测试商品',
    unitPrice: globalThis.__aiTest.mode === 'array-price' ? [20] : '20',
    quantity: globalThis.__aiTest.mode === 'fractional' ? 1.7 : globalThis.__aiTest.mode === 'boolean' ? true : 3,
    ...(globalThis.__aiTest.mode === 'tampered-plan' ? {
      plan: { totalCents: 1, groups: [{ usedCents: 1 }] },
      simulation: { version: 999, totalCents: 1 },
    } : {}),
  };
  return Response.json({choices: [{ message: { content: JSON.stringify(globalThis.__aiTest.mode === 'precheck' ? {summary:'测试', risks:[]} : draft) } }]});
};

const toModule = source => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/app/lib/ai.ts') && specifier === 'server-only') return toModule('export {};');
  if (context.parentURL?.endsWith('/app/lib/ai.ts') && specifier === './spreadsheets') return toModule('export const cents = value => Math.round(Number(value)*100);');
  if (context.parentURL?.endsWith('/app/lib/ai.ts') && specifier === './workflow') return toModule(`
    export const stateSummary = async () => ({version:globalThis.__aiTest.version,productHistory:[],sources:globalThis.__aiTest.sources ?? [],taxCount:0,batches:[]});
    export const getBatch = async () => globalThis.__aiTest.batch ?? null;
    export const simulate = async (...args) => {
      globalThis.__aiTest.calls.push(args);
      if(globalThis.__aiTest.mode === 'ambiguous') { const e = new Error('需确认'); e.code='AMBIGUOUS_ASSIGNMENT'; throw e; }
      if(globalThis.__aiTest.mode === 'stale') throw new Error('余额版本已变化，请刷新后重新试算。');
      return {version:27,product:args[0],priceCents:2000,plan:{groups:[],totalCents:6000,quantity:3,priceCents:2000}};
    };
  `);
  return next(specifier, context);
}});
const { aiParseDraft, aiPrecheck, aiAsk } = await import('../app/lib/ai.ts');

test('AI draft trial uses the same captured workspace version and never supplies guessed assignments', async () => {
  globalThis.__aiTest.mode = 'success';
  const result = await aiParseDraft('测试输入', 'test-user-success');
  assert.deepEqual(globalThis.__aiTest.calls.at(-1), ['测试商品', '20.00', 3, 27]);
  assert.deepEqual(result.plan, {groups:0,totalCents:6000,quantity:3});
  assert.deepEqual(result.simulation, {version:27,plan:{groups:[],totalCents:6000,quantity:3,priceCents:2000},product:'测试商品',priceCents:2000,assignments:[]});
  assert.equal(result.warning, null);
});

test('AI financial fields are ignored and the trusted solver owns the plan', async () => {
  globalThis.__aiTest.mode = 'tampered-plan';
  const before = globalThis.__aiTest.calls.length;
  const result = await aiParseDraft('测试输入', 'test-user-tampered');
  assert.equal(globalThis.__aiTest.calls.length, before + 1);
  assert.deepEqual(result.plan, {groups:0,totalCents:6000,quantity:3});
  assert.equal(result.simulation?.version, 27);
  assert.equal(result.simulation?.plan.totalCents, 6000);
  assert.notEqual(result.simulation?.plan.totalCents, 1);
});

test('DeepSeek timeout returns a safe retriable error without invoking the solver', async () => {
  globalThis.__aiTest.mode = 'timeout';
  const before = globalThis.__aiTest.calls.length;
  await assert.rejects(() => aiParseDraft('测试输入', 'test-user-timeout'), /连接超时/);
  assert.equal(globalThis.__aiTest.calls.length, before);
});

test('AI draft asks for manual confirmation when department assignment is ambiguous', async () => {
  globalThis.__aiTest.mode = 'ambiguous';
  const result = await aiParseDraft('测试输入', 'test-user-ambiguous');
  assert.equal(result.plan, null);
  assert.match(result.warning, /确认部门归属/);
  assert.equal(globalThis.__aiTest.calls.at(-1).length, 4);
});

test('AI draft surfaces stale workspace instead of silently retrying or committing', async () => {
  globalThis.__aiTest.mode = 'stale';
  const before = globalThis.__aiTest.calls.length;
  const result = await aiParseDraft('测试输入', 'test-user-stale');
  assert.equal(result.plan, null);
  assert.match(result.warning, /版本已变化/);
  assert.equal(globalThis.__aiTest.calls.length, before + 1);
});

test('AI draft rejects a fractional quantity instead of silently rounding it', async () => {
  globalThis.__aiTest.mode = 'fractional';
  const before = globalThis.__aiTest.calls.length;
  await assert.rejects(() => aiParseDraft('测试输入', 'test-user-fractional'), /正整数/);
  assert.equal(globalThis.__aiTest.calls.length, before);
});

test('AI draft rejects boolean quantities rather than treating true as one', async () => {
  globalThis.__aiTest.mode = 'boolean';
  const before = globalThis.__aiTest.calls.length;
  await assert.rejects(() => aiParseDraft('测试输入', 'test-user-boolean'), /正整数/);
  assert.equal(globalThis.__aiTest.calls.length, before);
});

test('AI draft rejects an array as a price rather than coercing it', async () => {
  globalThis.__aiTest.mode = 'array-price';
  const before = globalThis.__aiTest.calls.length;
  await assert.rejects(() => aiParseDraft('测试输入', 'test-user-array-price'), /有效单价/);
  assert.equal(globalThis.__aiTest.calls.length, before);
});

test('AI precheck correctly reports truncation beyond 200 groups without assuming full coverage', async () => {
  globalThis.__aiTest.mode = 'precheck';
  const group = { applicant:'测试', department:'', useCenter:'', costCenter:'测试', legalEntity:'测试', purpose:'测试', quantity:1, usedCents:100, remainderCents:0 };
  globalThis.__aiTest.batch = {product:'合成商品',status:'awaiting_review',data:{plan:{groups:Array.from({length:201},()=>group),sourceSummaries:[],quantity:201,totalCents:20100,priceCents:100},manifest:[],taxPending:0}};
  const result = await aiPrecheck('12345678', 'test-user-precheck');
  assert.match(result.risks[0].detail, /前 200 个分组/);
  assert.match(result.risks[0].evidence, /共 201 组/);
  const payload = globalThis.__aiTest.latestPrompt.messages[1].content;
  assert.match(payload, /"groupCount":201/);
  assert.match(payload, /"groupsIncluded":200/);
});

test('AI question context converts history from cents to yuan explicitly', async () => {
  globalThis.__aiTest.mode = 'success';
  globalThis.__aiTest.sources = [{name:'合成来源',priority:1,originalCents:50000,availableCents:37700,usedCents:12300,rowCount:1,history:[{batchId:'test',product:'合成商品',usedCents:12300}]}];
  await aiAsk('历史用额', 'test-user-history');
  const payload = globalThis.__aiTest.latestPrompt.messages[1].content;
  assert.match(payload, /"usedYuan":"123\.00"/);
  assert.doesNotMatch(payload, /"usedCents"/);
  globalThis.__aiTest.sources = [];
});
