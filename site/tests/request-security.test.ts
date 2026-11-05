import test from 'node:test';
import assert from 'node:assert/strict';
const {requestAddress,hasTrustedOrigin,isLocalReviewRequest}=await import(new URL('../app/lib/request-security.ts',import.meta.url).href);

function request(host:string,options:{origin?:string;proto?:string;forwardedHost?:string;ip?:string}={}){
 const h=new Headers({host});
 if(options.origin)h.set('origin',options.origin);
 if(options.proto)h.set('x-forwarded-proto',options.proto);
 if(options.forwardedHost)h.set('x-forwarded-host',options.forwardedHost);
 if(options.ip)h.set('x-forwarded-for',options.ip);
 return new Request('http://localhost:3028/api/workspace',{headers:h});
}

test('public HTTPS is restricted to the configured host, protocol, and exact Origin',()=>{
 const previous=process.env.ALLOCATION_PUBLIC_ORIGIN;
 process.env.ALLOCATION_PUBLIC_ORIGIN='https://allocation.example.invalid';
 try{
  const accepted=request('allocation.example.invalid',{proto:'https',origin:'https://allocation.example.invalid'});
  assert.deepEqual(requestAddress(accepted),{mode:'public',origin:'https://allocation.example.invalid'});
  assert.equal(hasTrustedOrigin(accepted),true);
  for(const bad of [
   request('evil.invalid',{proto:'https',origin:'https://evil.invalid',forwardedHost:'allocation.example.invalid'}),
   request('allocation.example.invalid',{proto:'http',origin:'https://allocation.example.invalid'}),
   request('allocation.example.invalid',{origin:'https://allocation.example.invalid'}),
   request('allocation.example.invalid',{proto:'https',origin:'https://evil.invalid'}),
   request('allocation.example.invalid',{proto:'https',origin:'http://allocation.example.invalid'}),
   request('allocation.example.invalid',{proto:'https'}),
  ])assert.equal(hasTrustedOrigin(bad),false);
  const spoof=request('allocation.example.invalid',{proto:'https',origin:'https://allocation.example.invalid',ip:'8.8.8.8'});
  assert.deepEqual(requestAddress(spoof),requestAddress(accepted),'forwarded IP cannot select another identity or origin');
  assert.equal(isLocalReviewRequest(accepted),false);
  assert.equal(isLocalReviewRequest(request('allocation.example.invalid',{proto:'https'})),false);
 }finally{if(previous===undefined)delete process.env.ALLOCATION_PUBLIC_ORIGIN;else process.env.ALLOCATION_PUBLIC_ORIGIN=previous;}
});

test('invalid public configuration fails closed and local SSH endpoint remains usable',()=>{
 const previous=process.env.ALLOCATION_PUBLIC_ORIGIN;
 try{
  for(const invalid of ['http://allocation.example.invalid','https://allocation.example.invalid/path','https://allocation.example.invalid/','https://u:p@allocation.example.invalid']){
   process.env.ALLOCATION_PUBLIC_ORIGIN=invalid;
   assert.equal(requestAddress(request('allocation.example.invalid',{proto:'https'})),null);
  }
  const local=request('localhost:3028',{origin:'http://localhost:3028'});
  assert.equal(hasTrustedOrigin(local),true);
  assert.equal(hasTrustedOrigin(request('localhost:3028',{origin:'http://evil.invalid'})),false);
  assert.equal(hasTrustedOrigin(request('localhost:3028',{origin:'http://localhost:3028',proto:'https'})),false);
  assert.equal(isLocalReviewRequest(request('localhost:3028')),true);
  assert.equal(isLocalReviewRequest(request('localhost:3028',{origin:'http://localhost:3028'})),false);
  assert.equal(isLocalReviewRequest(request('localhost:3028',{proto:'https'})),false);
 }finally{if(previous===undefined)delete process.env.ALLOCATION_PUBLIC_ORIGIN;else process.env.ALLOCATION_PUBLIC_ORIGIN=previous;}
});

test('multiple exact public HTTPS origins are independently trusted and invalid lists fail closed',()=>{
 const previous=process.env.ALLOCATION_PUBLIC_ORIGIN;
 try{
  process.env.ALLOCATION_PUBLIC_ORIGIN='https://allocation.example.invalid, https://backup.example.invalid';
  for(const origin of ['https://allocation.example.invalid','https://backup.example.invalid']){
   const host=new URL(origin).host;
   const accepted=request(host,{proto:'https',origin});
   assert.deepEqual(requestAddress(accepted),{mode:'public',origin});
   assert.equal(hasTrustedOrigin(accepted),true);
  }
  assert.equal(hasTrustedOrigin(request('backup.example.invalid',{proto:'https',origin:'https://allocation.example.invalid'})),false);
  assert.equal(hasTrustedOrigin(request('evil.invalid',{proto:'https',origin:'https://evil.invalid'})),false);
  for(const invalid of [
   'https://allocation.example.invalid,',
   'https://allocation.example.invalid,http://backup.example.invalid',
   'https://allocation.example.invalid,https://backup.example.invalid/path',
  ]){
   process.env.ALLOCATION_PUBLIC_ORIGIN=invalid;
   assert.equal(requestAddress(request('allocation.example.invalid',{proto:'https'})),null);
   assert.equal(requestAddress(request('backup.example.invalid',{proto:'https'})),null);
  }
 }finally{if(previous===undefined)delete process.env.ALLOCATION_PUBLIC_ORIGIN;else process.env.ALLOCATION_PUBLIC_ORIGIN=previous;}
});
