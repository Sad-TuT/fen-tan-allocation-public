import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const execFileAsync=promisify(execFile);
const project=fileURLToPath(new URL('../',import.meta.url));

test('synthetic review staging follows the hardened independent-source contract',async()=>{
  const {stdout}=await execFileAsync(process.execPath,['scripts/stage-synthetic-review.mjs'],{
    cwd:project,
    encoding:'utf8',
    maxBuffer:1024*1024,
  });
  const result=JSON.parse(stdout.trim().split(/\r?\n/).at(-1)??'');
  try{
    assert.equal(result.synthetic,true);
    assert.equal(result.workspaceVersion,3);
    assert.equal(result.status,'awaiting_review');
    assert.equal(result.files,6);
  }finally{
    if(typeof result.run==='string'&&path.resolve(result.run).startsWith(path.join(project,'work','dual-agent-synthetic')+path.sep)){
      await rm(result.run,{recursive:true,force:true});
    }
  }
});
