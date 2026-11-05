import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

const migration=readFileSync(new URL('../drizzle/0004_allocation_reference_guards.sql',import.meta.url),'utf8');

function legacyDb(){
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE local_schema_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL);
    CREATE TABLE allocation_batches(id TEXT PRIMARY KEY,data_key TEXT NOT NULL);
    CREATE TABLE allocation_workspace(id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0,data_key TEXT,last_batch_id TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE allocation_reviews(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,data_key TEXT NOT NULL);
    CREATE TABLE allocation_events(id TEXT PRIMARY KEY,batch_id TEXT,data_key TEXT);
  `);
  return db;
}

function applyMigration(db:DatabaseSync){
  db.exec('BEGIN IMMEDIATE');
  db.exec(migration);
  db.prepare("INSERT INTO local_schema_migrations(name,sha256) VALUES ('0004_allocation_reference_guards.sql',?)")
    .run('0'.repeat(64));
  db.exec('COMMIT');
}

for(const kind of ['review','workspace','event']){
  test(`migration rejects an existing ${kind} orphan before installing guards`,()=>{
    const db=legacyDb();
    try{
      if(kind==='review')db.exec("INSERT INTO allocation_reviews(id,batch_id,data_key) VALUES ('r','missing','reviews/r.json')");
      if(kind==='workspace')db.exec("INSERT INTO allocation_workspace(id,last_batch_id,updated_at) VALUES ('main','missing','now')");
      if(kind==='event')db.exec("INSERT INTO allocation_events(id,batch_id,data_key) VALUES ('e','missing',NULL)");
      assert.throws(()=>applyMigration(db),/existing orphan rows/);
      assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").get() as any).n),0);
      assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM local_schema_migrations').get() as any).n),0);
    }finally{db.close();}
  });
}

test('clean migration installs all guards and blocks new orphan references',()=>{
  const db=legacyDb();
  try{
    applyMigration(db);
    const triggers=Number((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").get() as any).n);
    assert.equal(triggers,7);
    assert.throws(
      ()=>db.prepare("INSERT INTO allocation_reviews(id,batch_id,data_key) VALUES ('r','missing','reviews/r.json')").run(),
      /allocation review batch does not exist/,
    );
    assert.throws(
      ()=>db.prepare("INSERT INTO allocation_workspace(id,last_batch_id,updated_at) VALUES ('main','missing','now')").run(),
      /allocation workspace batch does not exist/,
    );
  }finally{db.close();}
});
