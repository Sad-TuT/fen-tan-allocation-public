// Creates a single fresh local owner. Credentials are read from stdin, never args.
import {DatabaseSync} from 'node:sqlite';
import {randomBytes, randomUUID, scryptSync, createHash} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, chmodSync} from 'node:fs';
import path from 'node:path';
const root=process.env.ALLOCATION_DATA_DIR;
if(!root||!path.isAbsolute(root))throw new Error('ALLOCATION_DATA_DIR must be absolute.');
let input='';
for await(const chunk of process.stdin){input+=chunk;if(input.length>2048)throw new Error('Invalid input.');}
const v=JSON.parse(input);
if(typeof v.username!=='string'||! /^[a-z0-9][a-z0-9_.-]{1,63}$/.test(v.username)||typeof v.password!=='string'||v.password.length<6||Buffer.byteLength(v.password)>512)throw new Error('Invalid credentials.');
mkdirSync(root,{recursive:true,mode:0o700});
const db=new DatabaseSync(path.join(root,'ledger.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
try{
 db.exec('CREATE TABLE IF NOT EXISTS local_schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)');
 const dir=path.join(process.cwd(),'drizzle'),files=readdirSync(dir).filter(x=>/^\d{4}_[a-z0-9_]+\.sql$/.test(x)).sort();
 if(!files.length)throw new Error('Missing database migrations.');
 for(const name of files){const sql=readFileSync(path.join(dir,name),'utf8'),digest=createHash('sha256').update(sql).digest('hex');const row=db.prepare('SELECT sha256 FROM local_schema_migrations WHERE name=?').get(name);if(row&&row.sha256!==digest)throw new Error('Migration changed.');if(!row){db.exec(sql);db.prepare('INSERT INTO local_schema_migrations(name,sha256) VALUES(?,?)').run(name,digest);}}
 if(db.prepare('SELECT COUNT(*) AS count FROM app_users').get().count!==0)throw new Error('Account initialization already complete; existing accounts remain unchanged.');
 const salt=randomBytes(16), hash=scryptSync(v.password,salt,32,{N:32768,r:8,p:3,maxmem:48*1024*1024}),now=Date.now();
 db.prepare("INSERT INTO app_users (id,username,platform_owner_id,display_name,role,password_salt,password_hash,password_iterations,password_version,must_change_password,disabled,created_at,updated_at) VALUES (?,?,?,'管理员','admin',?,?,32768,1,0,0,?,?)").run(randomUUID(),v.username,'local-owner',salt.toString('hex'),'scrypt$32768$8$3$'+hash.toString('hex'),now,now);
 db.exec('COMMIT');
 chmodSync(path.join(root,'ledger.sqlite'),0o600);
 console.log('Administrator initialized.');
}catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
