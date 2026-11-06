import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {downloadTransfer,transferUrl,publicSource,transferFilename,transferError} from './transfer-download.mjs';
import {assertInstallerPlatform} from './transfer-access.mjs';

const safeId=id=>/^tr_[a-f0-9]{32}$/.test(String(id));
const bounded=(v,fallback,max)=>Number.isSafeInteger(v)&&v>0?Math.min(v,max):fallback;

export function createTransferService({file,cacheDir,getSettings,authorize,canSend,send,notify=async()=>{},audit=()=>{},
  download=downloadTransfer,now=Date.now,log=()=>{},autoStart=true}){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.mkdirSync(cacheDir,{recursive:true,mode:0o750});
  if(fs.lstatSync(cacheDir).isSymbolicLink()||fs.realpathSync(cacheDir)!==path.resolve(cacheDir))throw transferError('缓存目录不是独立普通目录',503);
  fs.chmodSync(cacheDir,0o2750);
  const db=new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,key TEXT,source_id TEXT,actor TEXT,kind TEXT,state TEXT,
      created INTEGER,updated INTEGER,bytes INTEGER DEFAULT 0,total INTEGER,data TEXT,result TEXT,error TEXT,UNIQUE(key,source_id));`);
  if(file!==':memory:')fs.chmodSync(file,0o600);
  db.prepare("UPDATE jobs SET state=CASE WHEN state='sending' THEN 'send_unknown' ELSE 'interrupted' END,error='桥接曾重启，未自动重试，请发送新请求',updated=? WHERE state IN ('queued','downloading','sending')").run(now());
  let running=false,closed=false,pumpPending=false;
  function settings(){
    const s=getSettings();if(!s?.enabled)throw transferError('图片/文件交付功能已关闭',403);
    return {...s,maxBytes:bounded(s.maxBytes,500000000,2000000000),maxImageBytes:bounded(s.maxImageBytes,20000000,50000000),
      cacheBytes:bounded(s.cacheBytes,2000000000,10000000000),retentionMs:bounded(s.retentionMs,86400000,7*86400000),
      maxPerUserHour:bounded(s.maxPerUserHour,3,20),maxPerGroupHour:bounded(s.maxPerGroupHour,8,50),maxQueue:bounded(s.maxQueue,8,32)};
  }
  function jobDir(id){
    if(!safeId(id))throw transferError('任务编号无效');
    const result=path.join(cacheDir,id);
    if(path.relative(cacheDir,result)!==id)throw transferError('任务目录无效');
    if(fs.existsSync(result)&&fs.lstatSync(result).isSymbolicLink())throw transferError('任务目录不是普通目录',403);
    return result;
  }
  function get(id){return db.prepare('SELECT * FROM jobs WHERE id=?').get(id);}
  function view(row){
    if(!row)return null;const data=JSON.parse(row.data),result=row.result?JSON.parse(row.result):null;
    return {ok:true,jobId:row.id,status:row.state,kind:row.kind,createdAt:new Date(row.created).toISOString(),bytes:row.bytes,totalBytes:row.total,
      filename:data.filename,title:data.title,platform:data.platform,version:data.version,source:publicSource(data.sourceUrl),
      sent:row.state==='sent',...result,...(row.error?{error:row.error}:{})};
  }
  function mark(id,state,extra={}){
    db.prepare('UPDATE jobs SET state=?,updated=?,result=COALESCE(?,result),error=? WHERE id=?').run(state,now(),extra.result?JSON.stringify(extra.result):null,extra.error||null,id);
  }
  function deleteCache(id){
    const dir=jobDir(id);if(!fs.existsSync(dir))return;
    // No recursive traversal of unknown paths; this service only creates ordinary files here.
    for(const name of fs.readdirSync(dir)){
      const f=path.join(dir,name),s=fs.lstatSync(f);
      if(!s.isFile()&&!s.isSymbolicLink())throw transferError('任务缓存结构异常，暂停清理',503);
      fs.unlinkSync(f);
    }
    fs.rmdirSync(dir);
  }
  function cacheSize(){
    let bytes=0;
    for(const name of fs.readdirSync(cacheDir)){
      if(!safeId(name))continue;const dir=jobDir(name);if(!fs.statSync(dir).isDirectory())continue;
      for(const child of fs.readdirSync(dir)){const s=fs.lstatSync(path.join(dir,child));if(s.isFile())bytes+=s.size;}
    }return bytes;
  }
  function cleanup(reserve=0){
    const s=settings();
    const rows=db.prepare("SELECT id,state,updated FROM jobs WHERE state NOT IN ('queued','downloading','sending') ORDER BY updated").all();
    for(const row of rows)if(row.updated<now()-s.retentionMs)deleteCache(row.id);
    let size=cacheSize();
    for(const row of rows){
      if(size+reserve<=s.cacheBytes)break;
      // A timed-out QQ send may still be reading its file; retain unknown outcomes until TTL.
      if(['send_unknown','uploaded_unverified'].includes(row.state))continue;
      deleteCache(row.id);size=cacheSize();
    }
    if(size+reserve>s.cacheBytes)throw transferError('本地缓存额度不足，请稍后再试',429);
    const disk=fs.statfsSync(cacheDir);if(disk.bavail*disk.bsize<reserve+1000000000)throw transferError('服务器可用磁盘不足，暂停下载',507);
  }
  async function safeNotify(job,text){
    try{if(canSend(job.key,job)){audit(text);if(await notify(job.key,text)===false)log('[transfer] notification not confirmed');}}catch{log('[transfer] notification not confirmed');}
  }
  async function perform(row){
    const data=JSON.parse(row.data);
    const job={...data,id:row.id,key:row.key,actor:row.actor,created:row.created,sourceId:row.source_id};
    let phase='downloading';
    try{
      const s=settings();
      if(!canSend(row.key,job)){mark(row.id,'cancelled',{error:'会话权限或请求状态已变化，未发送'});return;}
      const max=row.kind==='image'?s.maxImageBytes:s.maxBytes;
      cleanup(max);
      const dir=jobDir(row.id);fs.mkdirSync(dir,{mode:0o750});fs.chmodSync(dir,0o2750);
      if(Number.isInteger(s.sharedGid))fs.chownSync(dir,-1,s.sharedGid);
      const partial=path.join(dir,'payload.part'),asset=path.join(dir,data.filename);
      mark(row.id,'downloading');
      const metadata=await download({url:data.url,destination:partial,filename:data.filename,kind:row.kind,maxBytes:max,
        expectedSha256:data.expectedSha256,timeoutMs:600000,onProgress:(bytes,total)=>{
          if(!canSend(row.key,job))throw Object.assign(transferError('请求已取消或会话权限变化，未发送',409),{cancelled:true});
          db.prepare('UPDATE jobs SET bytes=?,total=?,updated=? WHERE id=?').run(bytes,total,now(),row.id);
        }});
      fs.renameSync(partial,asset);fs.chmodSync(asset,0o640);
      if(Number.isInteger(s.sharedGid))fs.chownSync(asset,-1,s.sharedGid);
      const stat=fs.lstatSync(asset);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==metadata.bytes||fs.realpathSync(asset)!==asset)throw transferError('下载产物路径检查失败',403);
      if(!canSend(row.key,job)){mark(row.id,'cancelled',{error:'下载完成，但会话权限或请求状态已变化，未发送'});deleteCache(row.id);return;}
      audit(data.filename);audit(data.title);audit(publicSource(data.sourceUrl));
      phase='sending';mark(row.id,'sending');
      // The injected sender must never retry after dispatch. It distinguishes chat verification from upload.
      const receipt=await send({...job,kind:row.kind,file:asset,bytes:metadata.bytes,sha256:metadata.sha256});
      const verified=receipt?.verified===true;
      const state=verified?'sent':'uploaded_unverified';
      const result={bytes:metadata.bytes,sha256:metadata.sha256,checksumMatched:Boolean(data.expectedSha256),verified,
        ...(receipt?.messageId?{messageId:String(receipt.messageId)}:{}),...(receipt?.fileId?{fileId:String(receipt.fileId)}:{})};
      mark(row.id,state,{result});
      log(`[transfer] ${row.id} ${state} bytes=${metadata.bytes}`);
      const title=`${verified?'已发送':'上传接口已受理，聊天回执尚未确认'}：${data.title}\n${data.filename} (${(metadata.bytes/1000000).toFixed(2)} MB)`;
      await safeNotify(job,`${title}${data.platform?`\n平台：${data.platform}`:''}${data.version?`；版本：${data.version}`:''}\n来源：${publicSource(data.sourceUrl)}\nSHA-256：${metadata.sha256}${verified?'':'\n请检查聊天/群文件；本任务不会自动重发。'}`);
    }catch(error){
      const status=error.cancelled?'cancelled':phase==='sending'?'send_unknown':'failed';
      const message=phase==='sending'?'发送结果未确认，不会自动重发，请查看群文件或使用新消息询问状态':
        error.statusCode?error.message:'下载或文件检查失败，请检查官方直链或网络后发起新请求';
      mark(row.id,status,{error:message});log(`[transfer] ${row.id} ${status} (${error.statusCode||502})`);
      await safeNotify(job,`文件任务未完成：${message}\n任务：${row.id}`);
      if(['failed','cancelled'].includes(status))try{deleteCache(row.id);}catch{}
    }
  }
  async function pump(){
    if(running||closed)return;running=true;
    try{
      while(!closed){
        const row=db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created LIMIT 1").get();if(!row)break;
        await perform(row);
      }
    }finally{running=false;}
  }
  function schedule(){
    if(!autoStart||pumpPending||closed)return;pumpPending=true;
    setImmediate(()=>{pumpPending=false;pump().catch(()=>log('[transfer] worker stopped; inspect ledger'));});
  }
  const sweep=setInterval(()=>{if(!running&&!closed)try{cleanup();}catch{};},60*60_000);sweep.unref();
  return {
    submit(input){
      if(closed)throw transferError('文件服务正在退出',503);
      const s=settings(),source=authorize(input);if(!source)throw transferError('需要本群15分钟内真实艾特的明确图片/文件请求；请读取真实来源消息ID',403);
      assertInstallerPlatform(source,input.platform);
      const existing=db.prepare('SELECT * FROM jobs WHERE key=? AND source_id=?').get(input.key,source.sourceId);
      if(existing)return {...view(existing),duplicate:true};
      if(!['image','file'].includes(input.kind))throw transferError('资源类型无效');
      const url=transferUrl(input.url).toString(),sourceUrl=transferUrl(input.sourceUrl).toString(),filename=transferFilename(input.filename);
      if(source.installer&&!url.startsWith('https:'))throw transferError('安装包请使用HTTPS官方下载地址');
      const title=String(input.title||filename).trim(),platform=String(input.platform||'').trim(),version=String(input.version||'').trim();
      if(title.length>100||platform.length>60||version.length>60)throw transferError('文件说明过长');
      if(input.expectedSha256&&!/^[a-f0-9]{64}$/i.test(input.expectedSha256))throw transferError('SHA-256须为64位十六进制');
      for(const value of [url,sourceUrl,filename,title,platform,version])audit(value);
      if(!canSend(input.key,{actor:source.userId,created:now()}))throw transferError('当前会话不允许发送文件',403);
      if(db.prepare("SELECT 1 FROM jobs WHERE key=? AND state IN ('queued','downloading','sending')").get(input.key))throw transferError('本群已有文件任务，请完成后再发起',429);
      if(db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('queued','downloading','sending')").get().n>=s.maxQueue)throw transferError('下载队列已满，请稍后再发起',429);
      const cutoff=now()-3600000;
      if(db.prepare('SELECT count(*) AS n FROM jobs WHERE actor=? AND created>?').get(source.userId,cutoff).n>=s.maxPerUserHour||
        db.prepare('SELECT count(*) AS n FROM jobs WHERE key=? AND created>?').get(input.key,cutoff).n>=s.maxPerGroupHour)throw transferError('本小时文件请求额度已用完',429);
      const id='tr_'+randomUUID().replaceAll('-',''),at=now();
      db.prepare('INSERT INTO jobs(id,key,source_id,actor,kind,state,created,updated,data) VALUES(?,?,?,?,?,?,?,?,?)').run(
        id,input.key,source.sourceId,source.userId,input.kind,'queued',at,at,JSON.stringify({url,sourceUrl,filename,title,platform,version,expectedSha256:input.expectedSha256||''}));
      schedule();return {...view(get(id)),sent:false,message:'任务已受理，后台完成后会自动交付；当前不是已发送，请勿另行上传或重复请求'};
    },
    status(key,id){if(!safeId(id))throw transferError('任务编号无效');const row=get(id);if(!row||row.key!==key)throw transferError('该任务不可用',404);return view(row);},
    requestStatus(key,sourceId){return db.prepare('SELECT state FROM jobs WHERE key=? AND source_id=?').get(key,String(sourceId))?.state||null;},
    pump,cleanup,
    async waitIdle(){while(running||pumpPending)await new Promise(r=>setTimeout(r,10));},
    close(){closed=true;clearInterval(sweep);if(running)throw transferError('仍有任务运行，尚未关闭',409);db.close();}
  };
}
