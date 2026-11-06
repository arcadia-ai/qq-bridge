import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Readable} from 'node:stream';import {createHash} from 'node:crypto';
import {captureTransferSource,findTransferRequest,assertInstallerPlatform,transferCancelled} from '../src/transfer-access.mjs';
import {transferUrl,transferFilename,verifyTransferType,downloadTransfer} from '../src/transfer-download.mjs';
import {createTransferService} from '../src/transfer-service.mjs';
import {createTransferApi} from '../src/transfer-api.mjs';
import {createTransferSender} from '../src/transfer-onebot.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const time=Date.now();
const event=(text,extra={})=>({message_type:'group',group_id:1,self_id:2,user_id:3,message_id:4,time:Math.floor(time/1000),message:[{type:'at',data:{qq:2}},{type:'text',data:{text}}],...extra});
const source=(text,id=4,extra={})=>({...captureTransferSource(event(text,{message_id:id}),time),...extra});
const find=(messages,kind='file',ref='4')=>findTransferRequest({key:'group:1',sourceMessageId:ref,kind,messages,now:time});
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'bigfish-transfer-test-'));
const remove=dir=>fs.rmSync(dir,{recursive:true,force:true});
const payload={key:'group:1',sourceMessageId:'4',kind:'file',url:'https://vendor.example/setup.txt',sourceUrl:'https://vendor.example/download',filename:'sample.txt',title:'测试文件'};

test('trusted inbound source, real mention and original event time',()=>{
 assert.ok(captureTransferSource(event('下载文件发群'),time));
 assert.equal(captureTransferSource(event('下载文件发群',{time:1}),time),null);
 assert.equal(captureTransferSource(event('下载文件发群',{message_id:0}),time),null);
 const noAt=captureTransferSource(event('下载文件发群',{message:[{type:'text',data:{text:'@大肥鱼下载文件发群'}}]}),time);
 assert.equal(find([noAt]),null);
 const f=event('下载文件发群');f.message.push({type:'forward',data:{id:'fake'}});assert.equal(captureTransferSource(f,time),null);
});
test('intent, wrong kind, notes, negation and source ownership are enforced',()=>{
 assert.equal(find([source('下载这个文件发群')]).userId,'3');
 assert.ok(find([source('给我找一张猫图')],'image'));
 assert.equal(find([source('给我找一张猫图')],'file'),null);
 for(const s of ['不要下载文件','例如下载这个文件发群','记一下：下载这个文件发群','今天天气不错'])assert.equal(find([source(s)]),null,s);
 assert.equal(find([{...source('下载这个文件发群'),isSelf:true}]),null);
 assert.equal(find([source('下载文件发群')],'file','99'),null);
});
test('installer platform must come from real request/clarification, not model guess',()=>{
 const orig=source('找一下编辑器安装包，下载后发群');
 const incomplete=find([orig]);assert.throws(()=>assertInstallerPlatform(incomplete,'Windows x64'));
 const clarified=find([orig,source('Windows 64位',5,{time:time+1})],'file','5');
 assertInstallerPlatform(clarified,'Windows x64');
 assert.throws(()=>assertInstallerPlatform(clarified,'Linux x64'));
 assert.equal(clarified.sourceId,'4');
 const other=source('Windows x64',5,{userId:'6'});assert.equal(find([orig,other],'file','5'),null);
});
test('a later same-user explicit cancellation revokes authorization',()=>{
 const m=[source('下载这个文件发群'),source('取消下载',5,{time:time+1})];
 assert.equal(find(m),null);
 assert.ok(transferCancelled(m,{actor:'3',created:time}));
 assert.ok(find([m[0],{...m[1],userId:'9'}]));
});
test('download URLs reject local paths, private addresses, credentials, fragments and odd ports',()=>{
 for(const u of ['file:///etc/passwd','http://127.0.0.1/a','http://2130706433/a','http://[::1]/a','http://169.254.169.254/a','http://192.168.1.1/a','http://host.local/a','https://u:p@example.com/a','https://example.com:8080/a','https://example.com/a#token'])assert.throws(()=>transferUrl(u),u);
 assert.equal(transferUrl('https://example.com/a.exe').hostname,'example.com');
});
test('ordinary filenames only; reject traversal, hidden files and bidirectional names',()=>{
 for(const n of ['../token.txt','/etc/passwd','a\\b.exe','.env','a.exe\u202e','a.svg','abc','bad?.exe'])assert.throws(()=>transferFilename(n),n);
 assert.equal(transferFilename('Firefox Setup.exe'),'Firefox Setup.exe');
});
test('file signatures detect images, installers, archives and fake HTML downloads',()=>{
 assert.equal(verifyTransferType(png,Buffer.alloc(0),'image.png','image').image,true);
 assert.equal(verifyTransferType(Buffer.from('MZsomeinstaller'),Buffer.alloc(0),'setup.exe','file').image,false);
 assert.equal(verifyTransferType(Buffer.from([0x50,0x4b,3,4]),Buffer.alloc(0),'archive.zip','file').image,false);
 for(const [data,name,kind,type] of [[Buffer.from('<html>login</html>'),'setup.exe','file',''],[png,'image.jpg','image',''],[Buffer.from('hello'),'setup.exe','file',''],[Buffer.from('login'),'sample.txt','file','text/html']])assert.throws(()=>verifyTransferType(data,Buffer.alloc(0),name,kind,type));
 assert.ok(verifyTransferType(Buffer.from('这是中文文档。'.repeat(300)),Buffer.alloc(0),'x.txt','file'));
});
function fakeResponse(bytes,status=200,headers={}){
 const res=Readable.from([bytes]);Object.assign(res,{statusCode:status,headers:{'content-length':String(bytes.length),...headers}});res.setTimeout=()=>{};
 return {res,req:{destroy(){}}};
}
test('streaming download counts, SHA-256 and validated redirects without real network',async()=>{
 const dir=temp(),seen=[];
 try{
  const result=await downloadTransfer({url:'https://vendor.example/image.png',filename:'image.png',kind:'image',destination:path.join(dir,'asset'),maxBytes:10000,
   validate:async u=>{seen.push(u);return {addresses:['8.8.8.8']};},
   open:async(u)=>u.hostname==='vendor.example'?fakeResponse(Buffer.alloc(0),302,{location:'https://cdn.example/image.png'}):fakeResponse(png)});
  assert.equal(result.bytes,png.length);assert.equal(result.sha256,createHash('sha256').update(png).digest('hex'));
  assert.equal(seen.length,2);assert.deepEqual(fs.readFileSync(path.join(dir,'asset')),png);
 }finally{remove(dir);}
});
test('streaming cap, wrong hash, private redirects and HTTPS downgrade fail closed',async()=>{
 const dir=temp();let n=0;
 const base=()=>({url:'https://vendor.example/file.txt',filename:'file.txt',kind:'file',destination:path.join(dir,String(n++)),maxBytes:1000,validate:async()=>({addresses:['8.8.8.8']})});
 try{
  await assert.rejects(downloadTransfer({...base(),maxBytes:2,open:async()=>fakeResponse(Buffer.from('too big'))}));
  await assert.rejects(downloadTransfer({...base(),expectedSha256:'a'.repeat(64),open:async()=>fakeResponse(Buffer.from('hello'))}));
  for(const location of ['http://127.0.0.1/file.txt','http://vendor.example/file.txt'])await assert.rejects(downloadTransfer({...base(),open:async()=>fakeResponse(Buffer.alloc(0),302,{location})}));
 }finally{remove(dir);}
});
function serviceFixture(options={}){
 const dir=options.dir||temp(),calls=[],notices=[];
 const settings={enabled:true,...options.settings};
 const service=createTransferService({file:path.join(dir,'jobs.sqlite3'),cacheDir:path.join(dir,'out'),getSettings:()=>settings,
  authorize:options.authorize||(input=>({sourceId:input.sourceMessageId,userId:'3',installer:false})),canSend:options.canSend||(()=>true),now:options.now||Date.now,
  download:options.download|| (async p=>{const b=Buffer.from('hello transfer');fs.writeFileSync(p.destination,b);p.onProgress(b.length,b.length);return {bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};}),
  send:options.send|| (async job=>{calls.push(job);return {verified:true,fileId:'file-1',messageId:'99'};}),
  notify:async(...args)=>notices.push(args),autoStart:false});
 return {dir,calls,notices,service,settings};
}
test('queue acknowledgement is not sent; one source is idempotent; files are non-executable',async()=>{
 const f=serviceFixture();
 try{
  const accepted=f.service.submit(payload);assert.equal(accepted.status,'queued');assert.equal(accepted.sent,false);assert.equal(f.calls.length,0);
  assert.equal(f.service.submit(payload).duplicate,true);
  await f.service.pump();const result=f.service.status(payload.key,accepted.jobId);
  assert.equal(result.status,'sent');assert.equal(result.verified,true);assert.equal(f.calls.length,1);
  assert.equal(fs.statSync(f.calls[0].file).mode&0o777,0o640);assert.equal(f.notices.length,1);
  assert.ok(!JSON.stringify(result).includes(f.dir));
 }finally{f.service.close();remove(f.dir);}
});
test('cross-group job reads, group concurrency and hourly quotas are blocked',async()=>{
 const f=serviceFixture({settings:{maxPerUserHour:1}});
 try{
  const r=f.service.submit(payload);
  assert.throws(()=>f.service.status('group:99',r.jobId));
  assert.throws(()=>f.service.submit({...payload,sourceMessageId:'5'}));
  await f.service.pump();assert.throws(()=>f.service.submit({...payload,sourceMessageId:'6'}));
 }finally{f.service.close();remove(f.dir);}
});
test('authorization, URL and filename errors never start a download',async()=>{
 const f=serviceFixture();
 try{
  for(const patch of [{url:'file:///etc/passwd'},{filename:'../credentials.txt'},{expectedSha256:'fake'}])assert.throws(()=>f.service.submit({...payload,...patch}));
  assert.equal(f.calls.length,0);
 }finally{f.service.close();remove(f.dir);}
});
test('permissions revoked during download cancel before any QQ send',async()=>{
 let allowed=true;
 const f=serviceFixture({canSend:()=>allowed,download:async p=>{fs.writeFileSync(p.destination,'hello');allowed=false;return {bytes:5,sha256:'a'.repeat(64)};}});
 try{const r=f.service.submit(payload);await f.service.pump();assert.equal(f.service.status(payload.key,r.jobId).status,'cancelled');assert.equal(f.calls.length,0);}
 finally{f.service.close();remove(f.dir);}
});
test('send ambiguity is durable and never retried after restart',async()=>{
 let sends=0;let f=serviceFixture({send:async()=>{sends++;throw Error('timeout');}});
 const dir=f.dir;
 try{
  const r=f.service.submit(payload);await f.service.pump();assert.equal(f.service.status(payload.key,r.jobId).status,'send_unknown');f.service.close();
  f=serviceFixture({dir,send:async()=>{sends++;return {verified:true};}});
  assert.equal(f.service.submit(payload).duplicate,true);await f.service.pump();assert.equal(sends,1);
 }finally{f.service.close();remove(dir);}
});
test('pending download interrupted by restart is not silently resumed',async()=>{
 const f=serviceFixture();const r=f.service.submit(payload);f.service.close();
 const g=serviceFixture({dir:f.dir});
 try{assert.equal(g.service.status(payload.key,r.jobId).status,'interrupted');assert.equal(g.service.submit(payload).duplicate,true);await g.service.pump();assert.equal(g.calls.length,0);}
 finally{g.service.close();remove(g.dir);}
});
test('download failures do not call QQ and disclose only a public error',async()=>{
 const f=serviceFixture({download:async()=>{throw Error('/private/secret/path');}});
 try{const r=f.service.submit(payload);await f.service.pump();const status=f.service.status(payload.key,r.jobId);assert.equal(status.status,'failed');assert.equal(f.calls.length,0);assert.ok(!JSON.stringify(status).includes('/private/'));}
 finally{f.service.close();remove(f.dir);}
});
test('transfer API always requires exact current-session token, even for console calls',()=>{
 let calls=0;const api=createTransferApi({enabled:()=>true,tokenOk:(k,t)=>k==='group:1'&&t==='one',sessionAllowed:()=>true,getService:()=>({submit:()=>{calls++;return {};},status:()=>{calls++;return {};}})});
 for(const [key,token] of [['group:1',''],['group:1','wrong'],['group:2','one'],['private:1','one']])assert.throws(()=>api.submit({key},token));
 assert.equal(calls,0);api.submit({key:'group:1'},'one');assert.equal(calls,1);
});
test('native image path uses an image segment and readback',async()=>{
 const calls=[];const sender=createTransferSender({selfQQ:()=>2,call:async(action,p)=>{calls.push({action,p});return action==='send_group_msg'?{message_id:9}:{group_id:1,message:[{type:'image'}]};}});
 const r=await sender({key:'group:1',kind:'image',file:'/shared/test.png',title:'test'});
 assert.equal(r.verified,true);assert.equal(calls[0].p.message[0].type,'image');assert.equal(calls.length,2);
});
test('group file requires its own chat receipt, not merely file_id',async()=>{
 let writes=0;const sender=createTransferSender({selfQQ:()=>2,sleep:async()=>{},call:async action=>{
  if(action==='upload_group_file'){writes++;return {file_id:'f1'};}
  return {messages:[]};
 }});
 const r=await sender({key:'group:1',kind:'file',file:'/shared/file.txt',filename:'file.txt'});
 assert.equal(r.verified,false);assert.equal(r.fileId,'f1');assert.equal(writes,1);
});
test('native group-file history match confirms only the current group and self',async()=>{
 const sender=createTransferSender({selfQQ:()=>2,call:async action=>action==='upload_group_file'?{file_id:'f1'}:{messages:[
  {group_id:2,user_id:2,message:[{type:'file',data:{file_id:'f1'}}]},
  {group_id:1,user_id:2,message_id:88,message:[{type:'file',data:{file_id:'f1'}}]}
 ]}});
 const r=await sender({key:'group:1',kind:'file',file:'/shared/file.txt',filename:'file.txt'});assert.equal(r.messageId,88);assert.equal(r.verified,true);
});

test('stream progress cancellation rejects normally instead of escaping the transform',async()=>{
 const dir=temp();
 try{await assert.rejects(downloadTransfer({url:'https://vendor.example/file.txt',filename:'file.txt',kind:'file',destination:path.join(dir,'asset'),maxBytes:100,
  validate:async()=>({addresses:['8.8.8.8']}),open:async()=>fakeResponse(Buffer.from('hello')),
  onProgress:()=>{throw Object.assign(Error('cancelled'),{cancelled:true});}}),/cancelled/);}
 finally{remove(dir);}
});

test('installer requests require HTTPS even after actual platform confirmation',()=>{
 const f=serviceFixture({authorize:input=>({sourceId:input.sourceMessageId,userId:'3',installer:true,platform:{os:'windows',arch:'x64'}})});
 try{assert.throws(()=>f.service.submit({...payload,url:'http://vendor.example/setup.exe',filename:'setup.exe',platform:'Windows x64'}),/HTTPS/);}
 finally{f.service.close();remove(f.dir);}
});

test('cache retention removes only payload; durable task state remains',async()=>{
 let clock=time;const f=serviceFixture({now:()=>clock,settings:{retentionMs:100}});
 try{const r=f.service.submit(payload);await f.service.pump();const file=f.calls[0].file;
  assert.ok(fs.existsSync(file));clock+=101;f.service.cleanup();assert.equal(fs.existsSync(file),false);
  assert.equal(f.service.status(payload.key,r.jobId).status,'sent');assert.equal(f.service.submit(payload).duplicate,true);}
 finally{f.service.close();remove(f.dir);}
});
