import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';import path from 'node:path';
const h=b=>createHash('sha256').update(b).digest('hex');
const work=path.resolve('work/backup-tests');mkdirSync(work,{recursive:true});
function run(env,args=[]){return spawnSync(process.execPath,[path.resolve('scripts/allocation-backup.mjs'),...args],{env:{...process.env,...env},encoding:'utf8'});}
function writeObject(root,key,content,type='application/json'){const meta=Buffer.from(JSON.stringify({contentType:type}));const head=Buffer.alloc(4);head.writeUInt32BE(meta.length);const file=path.join(root,'objects',...key.split('/'));mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,Buffer.concat([head,meta,Buffer.from(content)]));}
test('online backup, reference validation, restore drill, tamper rejection, and retention',()=>{
 const base=mkdtempSync(path.join(work,'synthetic-'));const data=path.join(base,'data'),dest=path.join(base,'backups');mkdirSync(data,{recursive:true});mkdirSync(path.join(data,'secrets'));writeFileSync(path.join(data,'secrets','never-backup'),'sample-secret');
 const db=new DatabaseSync(path.join(data,'ledger.sqlite'));db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE allocation_workspace(id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0,data_key TEXT,last_batch_id TEXT,updated_at TEXT NOT NULL);
  CREATE TABLE allocation_batches(id TEXT PRIMARY KEY,data_key TEXT NOT NULL);
  CREATE TABLE allocation_reviews(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,data_key TEXT NOT NULL);
  CREATE TABLE allocation_events(id TEXT PRIMARY KEY,batch_id TEXT,data_key TEXT);`);
 const sheet=Buffer.from('synthetic xlsx bytes');writeObject(data,'inputs/source.xlsx',sheet,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');writeObject(data,'workspace/state.json',JSON.stringify({sources:[{fileKey:'inputs/source.xlsx',sha256:h(sheet)}]}));db.prepare("INSERT INTO allocation_workspace(id,data_key,updated_at) VALUES ('main',?,'now')").run('workspace/state.json');
 const env={ALLOCATION_DATA_DIR:data,ALLOCATION_BACKUP_DIR:dest,ALLOCATION_BACKUP_KEEP:'2'};const first=run(env);assert.equal(first.status,0,first.stderr);const meta=JSON.parse(first.stdout);assert.equal(meta.restoreTest,'passed');assert.equal(meta.checks,1);assert.equal(existsSync(path.join(meta.backup,'secrets')),false);
 assert.equal(run(env,['verify',meta.backup]).status,0);
 writeFileSync(path.join(meta.backup,'objects','inputs','source.xlsx'),'corrupted');assert.notEqual(run(env,['verify',meta.backup]).status,0);
 const second=run(env),third=run(env);assert.equal(second.status,0,second.stderr);assert.equal(third.status,0,third.stderr);assert.equal(readdirSync(dest).filter(x=>x.startsWith('backup-')).length,2);
 const missing=path.join(data,'objects','inputs','source.xlsx');writeFileSync(missing,'broken');const failed=run(env);assert.notEqual(failed.status,0);assert.match(failed.stderr,/BACKUP FAILED/);assert.equal(readdirSync(dest).filter(x=>x.startsWith('backup-')).length,2);
 db.close();
});

test('backup fails closed when a tax override object is missing',()=>{
 const base=mkdtempSync(path.join(work,'missing-tax-override-'));const data=path.join(base,'data'),dest=path.join(base,'backups');mkdirSync(data,{recursive:true});
 const db=new DatabaseSync(path.join(data,'ledger.sqlite'));db.exec(`
   CREATE TABLE allocation_workspace(id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0,data_key TEXT,last_batch_id TEXT,updated_at TEXT NOT NULL);
   CREATE TABLE allocation_batches(id TEXT PRIMARY KEY,data_key TEXT NOT NULL);
   CREATE TABLE allocation_reviews(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,data_key TEXT NOT NULL);
   CREATE TABLE allocation_events(id TEXT PRIMARY KEY,batch_id TEXT,data_key TEXT);`);
 writeObject(data,'workspace/state.json',JSON.stringify({sources:[],taxOverrideFile:{key:'tax-overrides/missing.json',sha256:'a'.repeat(64)}}));
 db.prepare("INSERT INTO allocation_workspace(id,data_key,updated_at) VALUES ('main','workspace/state.json','now')").run();db.close();
 const result=run({ALLOCATION_DATA_DIR:data,ALLOCATION_BACKUP_DIR:dest,ALLOCATION_BACKUP_KEEP:'2'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/tax-overrides[\\/]missing\.json/);
 assert.equal(readdirSync(dest).filter(x=>x.startsWith('backup-')).length,0);
});

test('backup rejects SQLite workspace, review and event orphan references',()=>{
 for(const orphan of ['workspace','review','event']){
  const base=mkdtempSync(path.join(work,`orphan-${orphan}-`));const data=path.join(base,'data'),dest=path.join(base,'backups');mkdirSync(data,{recursive:true});
  const db=new DatabaseSync(path.join(data,'ledger.sqlite'));db.exec(`
    CREATE TABLE allocation_workspace(id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0,data_key TEXT,last_batch_id TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE allocation_batches(id TEXT PRIMARY KEY,data_key TEXT NOT NULL);
    CREATE TABLE allocation_reviews(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,data_key TEXT NOT NULL);
    CREATE TABLE allocation_events(id TEXT PRIMARY KEY,batch_id TEXT,data_key TEXT);`);
  writeObject(data,'workspace/state.json','{}');
  if(orphan==='workspace')db.prepare("INSERT INTO allocation_workspace(id,data_key,last_batch_id,updated_at) VALUES ('main','workspace/state.json','missing-batch','now')").run();
  else db.prepare("INSERT INTO allocation_workspace(id,data_key,updated_at) VALUES ('main','workspace/state.json','now')").run();
  if(orphan==='review')db.prepare("INSERT INTO allocation_reviews(id,batch_id,data_key) VALUES ('r','missing-batch','workspace/state.json')").run();
  if(orphan==='event')db.prepare("INSERT INTO allocation_events(id,batch_id) VALUES ('e','missing-batch')").run();
  db.close();
  const result=run({ALLOCATION_DATA_DIR:data,ALLOCATION_BACKUP_DIR:dest,ALLOCATION_BACKUP_KEEP:'2'});
  assert.notEqual(result.status,0,orphan);assert.match(result.stderr,/SQLite orphan/,orphan);
  assert.equal(readdirSync(dest).filter(x=>x.startsWith('backup-')).length,0,orphan);
 }
});

test('backup validates immutable per-batch input and result object digests',()=>{
 const base=mkdtempSync(path.join(work,'processing-object-validation-'));
 const data=path.join(base,'data'),dest=path.join(base,'backups');mkdirSync(data,{recursive:true});
 const db=new DatabaseSync(path.join(data,'ledger.sqlite'));
 db.exec(`CREATE TABLE allocation_workspace(id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0,data_key TEXT,last_batch_id TEXT,updated_at TEXT NOT NULL);
  CREATE TABLE allocation_batches(id TEXT PRIMARY KEY,data_key TEXT NOT NULL);
  CREATE TABLE allocation_reviews(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,data_key TEXT);
  CREATE TABLE allocation_events(id TEXT PRIMARY KEY,batch_id TEXT,data_key TEXT);
  CREATE TABLE app_users(id TEXT PRIMARY KEY);
  CREATE TABLE processing_jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES app_users(id),parent_job_id TEXT REFERENCES processing_jobs(id),status TEXT NOT NULL,data_key TEXT NOT NULL);
  INSERT INTO app_users(id) VALUES ('synthetic-owner');`);
 const input=Buffer.from('synthetic per-batch remaining source'),output=Buffer.from('synthetic candidate workbook');
 writeObject(data,'processing-jobs/job-1/inputs/source.xlsx',input,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 writeObject(data,'processing-jobs/job-1/results/candidate.xlsx',output,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 writeObject(data,'processing-jobs/job-1/state.json',JSON.stringify({
   files:[
     {role:'source',fileKey:'processing-jobs/job-1/inputs/source.xlsx',sha256:h(input)},
     {role:'invoice',key:'processing-jobs/job-1/results/candidate.xlsx',sha256:h(output)},
   ],
 }));
 db.prepare("INSERT INTO processing_jobs VALUES ('job-1','synthetic-owner',NULL,'prepared','processing-jobs/job-1/state.json')").run();
 db.close();
 const env={ALLOCATION_DATA_DIR:data,ALLOCATION_BACKUP_DIR:dest,ALLOCATION_BACKUP_KEEP:'2'};
 const good=run(env);assert.equal(good.status,0,good.stderr);
 const meta=JSON.parse(good.stdout);assert.equal(meta.restoreTest,'passed');assert.equal(meta.checks,2);
 assert.equal(run(env,['verify',meta.backup]).status,0);

 writeObject(data,'processing-jobs/job-1/inputs/source.xlsx',Buffer.from('tampered input'),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 const badInput=run(env);assert.notEqual(badInput.status,0);
 assert.match(badInput.stderr,/processing-jobs[\\/]job-1[\\/]inputs[\\/]source\.xlsx/);
 assert.equal(readdirSync(dest).filter(name=>name.startsWith('backup-')).length,1);

 writeObject(data,'processing-jobs/job-1/inputs/source.xlsx',input,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 writeObject(data,'processing-jobs/job-1/results/candidate.xlsx',Buffer.from('tampered output'),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 const badOutput=run(env);assert.notEqual(badOutput.status,0);
 assert.match(badOutput.stderr,/processing-jobs[\\/]job-1[\\/]results[\\/]candidate\.xlsx/);
 assert.equal(readdirSync(dest).filter(name=>name.startsWith('backup-')).length,1);
});
