import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseGroupMute,GroupMuteService,MAX_MUTE_MINUTES} from '../src/group-mute.mjs';
const config={ownerQQ:'1',groups:['100']};
const event=(text,extra={})=>({message_type:'group',group_id:100,user_id:1,self_id:2,message_id:'message',time:Math.floor(Date.now()/1000),message:[{type:'at',data:{qq:'2'}},{type:'text',data:{text}},{type:'at',data:{qq:'3'}}],...extra});
const info=async(group,user)=>({group_id:Number(group),user_id:Number(user),role:user==='2'?'admin':'member'});

test('combination phrasing, exact real mentions and 1 minute..30 days',()=>{
 for(const text of ['禁10分钟','把他禁 5 分钟','太吵了，禁他20分钟','180分钟，禁他','禁１８０分钟','禁181分钟','禁他2小时','禁1个小时','禁30天','禁７２０小时','禁４３２００分钟']){
  const p=parseGroupMute(event(text),config);assert.equal(p.action,'mute',text);assert(p.minutes>=1 && p.minutes<=MAX_MUTE_MINUTES);
 }
 for(const text of ['禁0分钟','禁43201分钟','禁721小时','禁31天','禁0小时','禁0天','禁-5分钟','禁1.5分钟','禁1.5小时','禁0.5天','禁1～5分钟','禁1分钟再禁2分钟','禁一下','禁1/2分钟'])assert(parseGroupMute(event(text),config).error,text);
 assert.equal(parseGroupMute(event('解除禁言'),config).action,'unmute');
 assert.equal(parseGroupMute(event('取消禁言'),config).minutes,0);
 assert(parseGroupMute(event('解禁10分钟'),config).error);
 const noAt=event('禁10分钟',{message:[{type:'text',data:{text:'@大肥鱼 @成员 禁10分钟'}}]});assert.equal(parseGroupMute(noAt,config).handled,false);
 assert(parseGroupMute(event('禁10分钟',{user_id:4}),config).error);
 assert(parseGroupMute(event('禁10分钟',{group_id:200}),config).error);
 assert(parseGroupMute(event('禁10分钟',{message_id:''}),config).error);
 assert(parseGroupMute(event('禁10分钟',{time:1}),config).error);
 assert(parseGroupMute(event('禁10分钟',{time:undefined}),config).error);
});
test('negation, questions, quotes, replies, forward payloads never execute',()=>{
 assert.equal(parseGroupMute(event('记一下：禁10分钟'),config).handled,false);
 assert.equal(parseGroupMute(event('备忘 修改 M-000001 禁10分钟'),config).handled,false);
 for(const text of ['不要禁10分钟','别禁10分钟','不禁10分钟','不再禁10分钟','禁10分钟可以吗','禁10分钟可以不','能否禁10分钟','禁10分钟？','例如禁10分钟','“禁10分钟”','‘禁10分钟’','如果刷屏就禁10分钟']){
  const p=parseGroupMute(event(text),config);assert(p.silent || !p.handled,text);
 }
 for(const type of ['reply','forward','json','node']){
  const e=event('禁10分钟');e.message.push({type,data:{id:'quoted'}});assert(parseGroupMute(e,config).silent);
 }
 const multi=event('禁10分钟');multi.message.push({type:'at',data:{qq:'4'}});assert(parseGroupMute(multi,config).error);
 const owner=event('禁10分钟');owner.message[2].data.qq='1';assert(parseGroupMute(owner,config).error);
});
test('single API invocation, seconds conversion, duplicate and解除',async()=>{
 const calls=[];const s=new GroupMuteService({file:':memory:',getMember:info,ban:async(...args)=>calls.push(args)});
 const r=await s.execute(event('禁180分钟'),config);assert.equal(r.state,'success');assert.deepEqual(calls,[['100','3',10800]]);
 assert.equal((await s.execute(event('禁180分钟'),config)).duplicate,true);assert.equal(calls.length,1);
 await s.execute(event('解除禁言',{message_id:'new'}),config);assert.deepEqual(calls[1],['100','3',0]);s.close();
});
test('permission and live allowlist checks refuse before remote write',async()=>{
 for(const role of ['owner','admin',undefined]){
  let calls=0;const s=new GroupMuteService({file:':memory:',getMember:async(g,u)=>({...await info(g,u),...(u==='3'?{role}:{})}),ban:async()=>calls++});
  assert.equal((await s.execute(event('禁10分钟'),config)).state,'rejected');assert.equal(calls,0);s.close();
 }
 let calls=0;const s=new GroupMuteService({file:':memory:',getMember:async(g,u)=>({...await info(g,u),role:'member'}),ban:async()=>calls++});
 assert.equal((await s.execute(event('禁10分钟'),config)).state,'rejected');assert.equal(calls,0);s.close();
 let checks=0;const changed=new GroupMuteService({file:':memory:',getMember:info,ban:async()=>calls++,allowed:()=>++checks===1});
 assert.equal((await changed.execute(event('禁10分钟'),config)).state,'rejected');assert.equal(calls,0);changed.close();
});
test('ambiguous failure never retries, including after reopening ledger',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'group-mute-')),file=path.join(dir,'ledger.sqlite');let calls=0;
 try{
  let s=new GroupMuteService({file,getMember:info,ban:async()=>{calls++;throw Error('simulated transport failure');}});
  assert.equal((await s.execute(event('禁10分钟'),config)).state,'uncertain');s.close();
  s=new GroupMuteService({file,getMember:info,ban:async()=>calls++});
  assert.equal((await s.execute(event('禁10分钟'),config)).duplicate,true);assert.equal(calls,1);s.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('untrusted or rejected messages do not call member lookup or muting',async()=>{
 let calls=0;const s=new GroupMuteService({file:':memory:',getMember:async()=>calls++,ban:async()=>calls++});
 await s.execute(event('禁10分钟',{user_id:4}),config);await s.execute(event('不要禁10分钟'),config);await s.execute(event('禁43201分钟'),config);
 assert.equal(calls,0);s.close();
});
test('new units convert exactly, preserving original unit for acknowledgements',()=>{
 for(const [text,minutes,label] of [['禁2小时',120,'2小时'],['禁1天',1440,'1天'],['禁30天',43200,'30天'],['禁720小时',43200,'720小时'],['禁43200分钟',43200,'43200分钟']]){
  const p=parseGroupMute(event(text),config);assert.equal(p.minutes,minutes,text);assert.equal(p.durationText,label,text);
 }
 for(const text of ['禁1天半','禁半天','禁一天','禁1小时30分','禁1天2小时','禁1～3天','禁1–2天','禁1小时到2','禁−2小时','禁1到2小时','禁1e2小时','禁1e-2小时','禁1:30小时','禁½天','禁1,120分钟','禁1周','解禁2小时','解禁半天'])assert(parseGroupMute(event(text),config).error,text);
});
test('hour/day API seconds, inclusive 30-day ceiling, no writes on ambiguous/over-limit input',async()=>{
 const calls=[];const s=new GroupMuteService({file:':memory:',getMember:info,ban:async(...args)=>calls.push(args)});
 const fixtures=[['禁2小时',7200],['禁1天',86400],['禁30天',2592000],['禁720小时',2592000],['禁43200分钟',2592000]];
 for(const [i,[text,seconds]] of fixtures.entries()){
  const r=await s.execute(event(text,{message_id:`valid-${i}`}),config);assert.equal(r.state,'success');
  assert.equal(calls.at(-1)[2],seconds);assert.ok(r.reply.includes(text.slice(1)));
 }
 for(const [i,text] of ['禁31天','禁721小时','禁43201分钟','禁1小时30分','禁1天半','不要禁30天','能否禁30天'].entries()){
  await s.execute(event(text,{message_id:`invalid-${i}`}),config);
 }
 assert.equal(calls.length,fixtures.length);
 assert.equal(s.db.prepare('SELECT minutes FROM actions WHERE message_id=?').get('valid-2').minutes,43200);
 s.close();
});
