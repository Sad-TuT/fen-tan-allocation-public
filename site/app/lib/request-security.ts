/** The reverse proxy must validate the public host and overwrite forwarded headers.
 * The Node service itself must remain bound to loopback and never be Internet-facing. */
type RequestMode='local'|'public';
type RouteAddress={mode:RequestMode;origin:string};

function configuredOrigin():URL|null {
 const raw=process.env.ALLOCATION_PUBLIC_ORIGIN;
 if(!raw)return null;
 try{
  const parsed=new URL(raw);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash||parsed.origin!==raw)return null;
  return parsed;
 }catch{return null;}
}

/** Determine the only permissible origin from the validated Host header.
 * No client-provided IP, X-Forwarded-Host, Forwarded, or arbitrary proxy header is trusted.
 * Forwarded proto is meaningful only behind the loopback-bound proxy contract. */
export function requestAddress(request:Request):RouteAddress|null {
 const parsed=new URL(request.url);
 const host=(request.headers.get('host')??parsed.host).toLowerCase();
 if(!/^[a-z0-9.\-\[\]:]+$/.test(host))return null;
 const forwarded=request.headers.get('x-forwarded-proto');
 if(/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)){
  if(forwarded&&forwarded.toLowerCase()!=='http')return null;
  return {mode:'local',origin:`http://${host}`};
 }
 const publicOrigin=configuredOrigin();
 if(publicOrigin&&host===publicOrigin.host.toLowerCase()&&forwarded?.toLowerCase()==='https')return {mode:'public',origin:publicOrigin.origin};
 return null;
}

/** Mutating browser requests must carry a matching explicit Origin. */
export function hasTrustedOrigin(request:Request):boolean {
 const address=requestAddress(request);
 return !!address&&request.headers.get('origin')===address.origin;
}

/** Only the local, unproxied channel can accept the independent review token. */
export function isLocalReviewRequest(request:Request):boolean {
 return requestAddress(request)?.mode==='local'&&!request.headers.has('origin');
}
