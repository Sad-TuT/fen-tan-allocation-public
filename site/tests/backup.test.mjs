import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';import path from 'node:path';
const h=b=>createHash('sha256').update(b).digest('hex');
const work=path.resolve('work/backup-tests');mkdirSync(work,{recursive:true});
function run(env,args=[]){return spawnSync(process.execPath,[path.resolve('scripts/allocation-backup.mjs'),...args],{env:{...process.env,...env},encoding:'utf8'});}
function writeObject(root,key,content,type='application/json'){const meta=Buffer.from(JSON.stringify({contentType:type}));const head=Buffer.alloc(4);head.writeUInt32BE(meta.length);const file=path.join(root,'objects',...key.split('/'));mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,Buffer.concat([head,meta,Buffer.from(content)]));}
test('online backup, reference validation, restore drill, tamper rejection, and retention',()=>{
 const base=mkdtempSync(path.join(work,'synthetic-'));const data=path.join(base,'data'),dest=path.join(base,'backups');mkdirSync(data,{recursive:true});mkdirSync(path.join(data,'secrets'));writeFileSync(path.join(data,'secrets','never-backup'),'sample-secret');
 const db=new DatabaseSync(path.join(data,'ledger.sqlite'));db.exec('PRAGMA journal_mode=WAL; CREATE TABLE allocation_workspace(data_key TEXT); CREATE TABLE allocation_batches(data_key TEXT); CREATE TABLE allocation_reviews(data_key TEXT);');
 const sheet=Buffer.from('synthetic xlsx bytes');writeObject(data,'inputs/source.xlsx',sheet,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');writeObject(data,'workspace/state.json',JSON.stringify({sources:[{fileKey:'inputs/source.xlsx',sha256:h(sheet)}]}));db.prepare('INSERT INTO allocation_workspace(data_key) VALUES (?)').run('workspace/state.json');
 const env={ALLOCATION_DATA_DIR:data,ALLOCATION_BACKUP_DIR:dest,ALLOCATION_BACKUP_KEEP:'2'};const first=run(env);assert.equal(first.status,0,first.stderr);const meta=JSON.parse(first.stdout);assert.equal(meta.restoreTest,'passed');assert.equal(meta.checks,1);assert.equal(existsSync(path.join(meta.backup,'secrets')),false);
 assert.equal(run(env,['verify',meta.backup]).status,0);
 writeFileSync(path.join(meta.backup,'objects','inputs','source.xlsx'),'corrupted');assert.notEqual(run(env,['verify',meta.backup]).status,0);
 const second=run(env),third=run(env);assert.equal(second.status,0,second.stderr);assert.equal(third.status,0,third.stderr);assert.equal(readdirSync(dest).filter(x=>x.startsWith('backup-')).length,2);
 const missing=path.join(data,'objects','inputs','source.xlsx');writeFileSync(missing,'broken');const failed=run(env);assert.notEqual(failed.status,0);assert.match(failed.stderr,/BACKUP FAILED/);assert.equal(readdirSync(dest).filter(x=>x.startsWith('backup-')).length,2);
 db.close();
});
