import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {validateFetchUrl,isPrivateIp} from './safe-fetch.js';

export const transferError=(message,statusCode=400)=>Object.assign(Error(message),{statusCode});
export function transferUrl(raw){
  let u;try{u=new URL(String(raw));}catch{throw transferError('下载地址无效');}
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.hash||u.port&&!['80','443'].includes(u.port))throw transferError('只接受无凭据的公网HTTP(S)普通端口链接');
  const h=u.hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
  if(h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h==='metadata.google.internal'||net.isIP(h)&&isPrivateIp(h))throw transferError('下载地址不是允许的公网地址');
  return u;
}
export function publicSource(raw){const u=transferUrl(raw);return u.origin+u.pathname;}
const extensions=['.tar.gz','.tar.xz','.tar.bz2','.appimage','.exe','.msi','.dmg','.pkg','.apk','.deb','.rpm','.zip','.7z','.gz','.tgz','.xz','.bz2','.tar','.pdf','.txt','.md','.csv','.json','.png','.jpg','.jpeg','.gif','.webp'];
export function transferFilename(raw){
  const s=String(raw??'').normalize('NFKC').trim();
  if(!s||Buffer.byteLength(s)>180||/[\\/<>:"|?*\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(s)||s.startsWith('.')||s.endsWith('.')||s.endsWith(' '))throw transferError('请提供普通文件名，不要路径或特殊字符');
  if(!extensions.some(x=>s.toLowerCase().endsWith(x)))throw transferError('首版仅支持常见安装包、压缩包、文档和PNG/JPEG/GIF/WebP图片');
  return s;
}
export function verifyTransferType(prefix,tail,filename,kind,contentType=''){
  const s=prefix.subarray(0,1024).toString('utf8').trimStart();
  if(!prefix.length||/text\/html|application\/xhtml/i.test(contentType)||/^(?:<!doctype\s+html|<html\b|<\?xml)/i.test(s))throw transferError('下载返回网页/登录页而不是所需文件',422);
  const ext=extensions.find(x=>filename.toLowerCase().endsWith(x));
  const png=prefix.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpg=prefix[0]===255&&prefix[1]===216&&prefix[2]===255;
  const gif=/^GIF8[79]a/.test(prefix.toString('ascii',0,6));
  const webp=prefix.toString('ascii',0,4)==='RIFF'&&prefix.toString('ascii',8,12)==='WEBP';
  const image=png?'.png':jpg?'.jpg':gif?'.gif':webp?'.webp':null;
  if(kind==='image'||['.png','.jpg','.jpeg','.gif','.webp'].includes(ext)){
    if(!image||(ext==='.jpeg'?'.jpg':ext)!==image)throw transferError('图片实际格式与文件名不一致',422);
    return {type:image.slice(1),image:true};
  }
  const hex=prefix.subarray(0,8).toString('hex'),ascii=prefix.toString('ascii',0,8);
  const zip=['504b0304','504b0506','504b0708'].some(x=>hex.startsWith(x));
  const ok=ext==='.exe'?ascii.startsWith('MZ'):ext==='.msi'?hex==='d0cf11e0a1b11ae1':
    ['.zip','.apk'].includes(ext)?zip:ext==='.7z'?hex.startsWith('377abcaf271c'):
    ['.gz','.tgz','.tar.gz'].includes(ext)?hex.startsWith('1f8b'):
    ['.xz','.tar.xz'].includes(ext)?hex.startsWith('fd377a585a00'):
    ['.bz2','.tar.bz2'].includes(ext)?ascii.startsWith('BZh'):
    ext==='.deb'?ascii==='!<arch>\n':ext==='.rpm'?hex.startsWith('edabeedb'):
    ext==='.appimage'?hex.startsWith('7f454c46'):ext==='.pkg'?ascii.startsWith('xar!'):
    ext==='.dmg'?tail.length>=512&&tail.toString('ascii',tail.length-512,tail.length-508)==='koly':
    ext==='.tar'?prefix.toString('ascii',257,262)==='ustar':ext==='.pdf'?ascii.startsWith('%PDF-'):
    ['.txt','.md','.csv','.json'].includes(ext)?!prefix.includes(0):false;
  if(!ok)throw transferError('文件头检查未通过，未发送（可能不是所选安装包或文件）',422);
  return {type:ext.slice(1),image:false};
}
function openResponse(u,address,remaining){
  return new Promise((resolve,reject)=>{
    const host=u.hostname.replace(/^\[|\]$/g,'');
    const req=(u.protocol==='https:'?https:http).request({hostname:address,port:u.port||(u.protocol==='https:'?443:80),
      servername:u.protocol==='https:'&&!net.isIP(host)?host:undefined,rejectUnauthorized:true,agent:false,
      path:u.pathname+u.search,method:'GET',headers:{host:u.host,'user-agent':'BigfishTransfer/1.0',accept:'*/*','accept-encoding':'identity'}},res=>{
        clearTimeout(timer);
        if(isPrivateIp(res.socket.remoteAddress)){res.destroy();reject(transferError('下载连接未通过公网地址核验',403));return;}
        resolve({res,req});
      });
    const timer=setTimeout(()=>req.destroy(transferError('下载连接超时',504)),Math.min(12000,remaining));
    req.once('error',e=>{clearTimeout(timer);reject(e);});req.end();
  });
}

// Inject URL validation/transport only for local fixtures. Production always uses validated, pinned IPs.
export async function downloadTransfer({url,destination,filename,kind,maxBytes,expectedSha256,timeoutMs=600000,onProgress=()=>{},
  validate=raw=>validateFetchUrl(raw,{allowPorts:[80,443]}),open=openResponse}){
  let u=transferUrl(url);const deadline=Date.now()+timeoutMs;
  let active;
  const timer=setTimeout(()=>{active?.req.destroy(transferError('下载超过总时限',504));active?.res.destroy(transferError('下载超过总时限',504));},timeoutMs);
  try{
    for(let hop=0;hop<=5;hop++){
      if(Date.now()>=deadline)throw transferError('下载超时',504);
      const checked=await validate(u.toString());let error;
      for(const address of checked.addresses.slice(0,4)){
        if(Date.now()>=deadline)throw transferError('下载超时',504);
        try{active=await open(u,address,Math.max(1,deadline-Date.now()));error=null;break;}catch(e){error=e;}
      }
      if(error||!active)throw transferError('未能连接下载源，请检查源站或网络',502);
      const {res,req}=active;
      if([301,302,303,307,308].includes(res.statusCode)){
        const next=res.headers.location;res.destroy();req.destroy();active=null;
        if(!next||hop===5)throw transferError('下载跳转次数过多或缺少目标',502);
        const redirected=transferUrl(new URL(next,u).toString());
        if(u.protocol==='https:'&&redirected.protocol!=='https:')throw transferError('下载源跳转降级为明文HTTP，已停止',403);
        u=redirected;continue;
      }
      if(res.statusCode!==200){res.destroy();throw transferError(`下载源返回HTTP ${res.statusCode}，未取得完整文件`,502);}
      const total=Number(res.headers['content-length']);
      if(Number.isFinite(total)&&total>maxBytes){res.destroy();throw transferError('文件超过本次大小上限',413);}
      if(res.headers['content-encoding']&&!/^identity$/i.test(res.headers['content-encoding'])){res.destroy();throw transferError('下载源返回不支持的传输压缩格式',422);}
      let bytes=0,prefix=Buffer.alloc(0),tail=Buffer.alloc(0),last=0;
      const hash=createHash('sha256');
      const meter=new Transform({transform(chunk,enc,cb){
        bytes+=chunk.length;
        if(bytes>maxBytes){cb(transferError('文件超过本次大小上限',413));return;}
        hash.update(chunk);
        if(prefix.length<65536)prefix=Buffer.concat([prefix,chunk.subarray(0,65536-prefix.length)]);
        tail=Buffer.concat([tail,chunk.subarray(Math.max(0,chunk.length-512))]).subarray(-512);
        if(Date.now()-last>=1000){
          last=Date.now();try{onProgress(bytes,Number.isFinite(total)?total:null);}catch(error){cb(error);return;}
        }
        cb(null,chunk);
      }});
      res.setTimeout(30000,()=>res.destroy(transferError('下载长时间没有响应',504)));
      await pipeline(res,meter,fs.createWriteStream(destination,{flags:'wx',mode:0o600}));
      if(Number.isFinite(total)&&total!==bytes)throw transferError('下载长度不完整',502);
      const sha256=hash.digest('hex');
      if(expectedSha256&&sha256!==String(expectedSha256).toLowerCase())throw transferError('SHA-256与提供的校验值不一致，未发送',422);
      const type=verifyTransferType(prefix,tail,filename,kind,String(res.headers['content-type']||''));
      onProgress(bytes,bytes);
      return {bytes,sha256,type:type.type,finalSource:publicSource(u.toString())};
    }
    throw transferError('下载跳转失败',502);
  }finally{clearTimeout(timer);active?.req.destroy();active?.res.destroy();}
}
