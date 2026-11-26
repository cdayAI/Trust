'use strict';
import type {RustCore,RequestEnvelope,CorporateOrigin,ConnectionDecision,PostDecision} from './contracts';
const rust:RustCore=require('./rust-core');
const {loopbackAddresses}:{loopbackAddresses:ReadonlySet<string|undefined>}=require('./operational-health');
// Reference mode and the compiled core preserve the same status precedence.
function connection(req:RequestEnvelope,oidc?:CorporateOrigin|null,remote=req.socket.remoteAddress):ConnectionDecision{
  const {host}=req.headers;
  if(rust.enabled)return rust.httpConnection(remote,host,req.url,oidc?.host,!!req.socket.encrypted,!!oidc?.secure);
  if(!loopbackAddresses.has(remote))return 1;
  if(oidc){
    if(host!==oidc.host||Boolean(req.socket.encrypted)!==oidc.secure||
      !req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\'))return 2;
  }else if(!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(String(host||'')))return 1;
  return 0;
}
function post(req:RequestEnvelope,isolated:boolean,oidc:CorporateOrigin|null|undefined,binary:boolean,binaryType:string):PostDecision{
  const {host,origin,'content-type':contentType,'content-encoding':contentEncoding}=req.headers;
  if(rust.enabled)return rust.httpPost(host,origin,oidc?.origin,contentType,contentEncoding,binaryType,isolated,binary);
  if((isolated&&origin!==(oidc?.origin??'http://'+host))||
    (origin&&origin!=='http://'+host&&origin!=='https://'+host))return 1;
  if(binary){
    if(contentType!==binaryType||contentEncoding)return 2;
  }else if(!/^application\/json(?:\s*;|$)/i.test(String(contentType||'')))return 3;
  return 0;
}
export = Object.freeze({connection,post});
