import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier==='server-only')return {url:'data:text/javascript,export default {}',shortCircuit:true};return next(specifier,context);}});
const {env}=await import('../app/lib/node-runtime.ts');
if(process.argv[2]==='read'){
 const row=await env.DB.prepare('SELECT version FROM allocation_workspace WHERE id=?').bind('main').first();
 const object=await env.BUCKET.get('evidence/nested/test.bin');
 console.log(JSON.stringify({version:row?.version,bytes:object?Buffer.from(await object.arrayBuffer()).toString():null}));
}else if(process.argv[2]==='race'){
 const result=await env.DB.batch([
  env.DB.prepare('UPDATE allocation_workspace SET version=version+1 WHERE id=? AND version=?').bind('main',0),
  env.DB.prepare('INSERT INTO allocation_events (id,kind,actor,created_at,detail_json) SELECT ?,?,?,?,? WHERE changes()=1').bind(process.argv[3],'race','test','now','{}'),
 ]);
 console.log(JSON.stringify({changes:result[0].meta.changes,event:result[1].meta.changes}));
} else throw new Error('unknown test');
