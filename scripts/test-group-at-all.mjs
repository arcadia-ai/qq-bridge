import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parseGroupAtAll,GroupAtAllService} from '../src/group-at-all.mjs';
const time=Date.now();const config={ownerQQ:11,groups:[22]};
const event=(text='帮我艾特一下全体成员',extra={})=>({message_type:'group',group_id:22,user_id:11,self_id:33,message_id:44,time:Math.floor(time/1000),message:[{type:'at',data:{qq:33}},{type:'text',data:{text}}],...extra});
const parse=e=>parseGroupAtAll(e,config,time);
function fixture(options={}){
 const dir=options.dir||fs.mkdtempSync(path.join(os.tmpdir(),'qq-at-all-test-'));const sends=[],checks=[];
 const service=new GroupAtAllService({file:path.join(dir,'actions.sqlite3'),now:()=>time,
 getMember:options.getMember|| (async(g,u)=>{checks.push('member');return {group_id:Number(g),user_id:Number(u),role:'admin'};}),
 getQuota:options.getQuota|| (async()=>{checks.push('quota');return {can_at_all:true,remain_at_all_count_for_group:3,remain_at_all_count_for_uin:2};}),
 send:options.send|| (async c=>{sends.push(c);return {message_id:-55};}),allowed:options.allowed||(()=>true),timeoutMs:options.timeoutMs||100});
 return {dir,service,sends,checks,close(){service.close();if(!options.keep)fs.rmSync(dir,{recursive:true,force:true});}};
}
test('recognizes explicit command aliases, fullwidth and real @ only',()=>{
 for(const text of ['帮我艾特一下全体成员','艾特全体','请帮我艾特一下全体成员！','麻烦艾特所有人','帮我@一下全体成员','＠全体成员'])assert.equal(parse(event(text)).messageId,'44',text);
 assert.equal(parse(event(undefined,{message:[{type:'text',data:{text:'@大肥鱼 帮我艾特一下全体成员'}}]})).handled,false);
 assert.equal(parse(event(undefined,{message_type:'private'})).handled,false);
});
test('questions, negation, notes, quotes, conditions and extra content never execute',()=>{
 for(const text of ['能不能艾特全体成员？','不要艾特全体成员','别艾特全体','记一下 帮我艾特一下全体成员','补记 艾特全体','如果开会就艾特全体','例如艾特全体','“帮我艾特一下全体成员”','艾特全体成员，今晚开会','我刚才让你艾特全体成员'])assert.equal(parse(event(text)).handled,false,text);
 for(const type of ['reply','forward','node','json','xml','image']){
  const e=event();e.message.push({type,data:{text:'fake'}});assert.equal(parse(e).silent,true);
 }
});
test('owner, allowlisted current group and no extra targets are required',()=>{
 assert.match(parse(event(undefined,{user_id:12})).reply,/仅主人/);
 assert.match(parse(event(undefined,{group_id:23})).reply,/未开放/);
 const e=event();e.message.push({type:'at',data:{qq:66}});assert.equal(parse(e).silent,true);
});
test('rejects missing, zero or stale IDs/times and delayed replay',()=>{
 for(const extra of [{message_id:0},{message_id:null},{message_id:'fake'},{time:0},{time:NaN},{time:Math.floor(time/1000)-301},{time:Math.floor(time/1000)+62}])assert.ok(parse(event(undefined,extra)).reply);
 assert.equal(parse(event(undefined,{message_id:-99})).messageId,'-99');
});
test('valid source performs fresh member and quota checks then exactly one send',async()=>{
 const f=fixture();try{const r=await f.service.execute(event(),config);assert.equal(r.state,'success');assert.deepEqual(f.checks,['member','quota']);assert.equal(f.sends.length,1);assert.equal(f.sends[0].group,'22');assert.equal(r.reply,undefined);assert.equal(fs.statSync(path.join(f.dir,'actions.sqlite3')).mode&0o777,0o600);}finally{f.close();}
});
test('non-owner and disallowed group never query or write to QQ',async()=>{
 const f=fixture();try{await f.service.execute(event(undefined,{user_id:12}),config);await f.service.execute(event(undefined,{group_id:23}),config);assert.equal(f.checks.length,0);assert.equal(f.sends.length,0);}finally{f.close();}
});
test('missing admin, wrong bot identity or wrong group fails closed',async()=>{
 for(const member of [{user_id:33,role:'member'},{user_id:34,role:'admin'},{user_id:33,group_id:23,role:'owner'},{}]){
  const f=fixture({getMember:async()=>member});try{const r=await f.service.execute(event(),config);assert.equal(r.state,'rejected');assert.equal(f.sends.length,0);assert.equal(f.checks.length,0);}finally{f.close();}
 }
});
test('quota false, exhausted, missing, malformed or unexpected types never send',async()=>{
 const good={can_at_all:true,remain_at_all_count_for_group:3,remain_at_all_count_for_uin:2};
 for(const q of [{...good,can_at_all:false},{...good,remain_at_all_count_for_group:0},{...good,remain_at_all_count_for_uin:0},{...good,remain_at_all_count_for_group:'3'},{...good,remain_at_all_count_for_uin:-1},null,{}]){
  const f=fixture({getQuota:async()=>q});try{assert.equal((await f.service.execute(event(),config)).state,'rejected');assert.equal(f.sends.length,0);}finally{f.close();}
 }
});
test('permissions changing after checks prevent send',async()=>{
 let allowed=true;const f=fixture({allowed:()=>allowed,getQuota:async()=>{allowed=false;return {can_at_all:true,remain_at_all_count_for_group:3,remain_at_all_count_for_uin:2};}});
 try{assert.equal((await f.service.execute(event(),config)).state,'rejected');assert.equal(f.sends.length,0);}finally{f.close();}
});
test('duplicate deliveries including concurrent ones execute once',async()=>{
 const f=fixture();try{const r=await Promise.all([f.service.execute(event(),config),f.service.execute(event(),config)]);assert.equal(f.sends.length,1);assert.equal(r[1].duplicate,true);}finally{f.close();}
});
test('distinct commands serialize quota checks, not race past last remaining quota',async()=>{
 let left=1,writes=0;const f=fixture({getQuota:async()=>({can_at_all:true,remain_at_all_count_for_group:left,remain_at_all_count_for_uin:left}),send:async()=>{writes++;left--;return {message_id:55};}});
 try{const r=await Promise.all([f.service.execute(event(),config),f.service.execute(event(undefined,{message_id:45}),config)]);assert.equal(writes,1);assert.deepEqual(r.map(x=>x.state),['success','rejected']);}finally{f.close();}
});
test('timeout produces durable uncertainty and aborts pending sender',async()=>{
 let signal,writes=0;const f=fixture({keep:true,timeoutMs:10,send:async(c,s)=>{writes++;signal=s;await new Promise(r=>setTimeout(r,30));return {message_id:55};}});
 try{assert.equal((await f.service.execute(event(),config)).state,'uncertain');assert.equal(signal.aborted,true);}finally{f.service.close();}
 const g=fixture({dir:f.dir,send:async()=>{writes++;return {message_id:56};}});
 try{assert.equal((await g.service.execute(event(),config)).duplicate,true);assert.equal(writes,1);}finally{g.close();}
});
test('missing receipt never counts as confirmed or retries',async()=>{
 const f=fixture({send:async()=>({})});try{assert.equal((await f.service.execute(event(),config)).state,'uncertain');assert.equal((await f.service.execute(event(),config)).duplicate,true);}finally{f.close();}
});
test('restart abandons checking/sending entries without resuming actions',async()=>{
 const f=fixture({keep:true});
 f.service.db.prepare('INSERT INTO actions VALUES(?,?,?,?,?,?,NULL)').run('22','44','11','sending',time,time);
 f.service.db.prepare('INSERT INTO actions VALUES(?,?,?,?,?,?,NULL)').run('22','45','11','checking',time,time);f.service.close();
 const g=fixture({dir:f.dir});try{assert.equal((await g.service.execute(event(),config)).state,'uncertain');assert.equal((await g.service.execute(event(undefined,{message_id:45}),config)).state,'interrupted');assert.equal(g.sends.length,0);}finally{g.close();}
});
test('bridge wiring stays narrow and general text sending still rejects all',()=>{
 const root=new URL('..',import.meta.url);const s=fs.readFileSync(new URL('src/bridge.js',root),'utf8');
 assert.match(s,/groupAtAll: \{ enabled: file.groupAtAll\?\.enabled === true \}/);
 assert.match(s,/parseGroupAtAll\(event,atAllConfig\)/);
 assert.ok(s.indexOf('const candidate=parseGroupAtAll')<s.indexOf('const memoCommand = parseMemo'));
 assert.match(s,/if\(!response.ok\|\|body.status!=='ok'\|\|body.retcode!==0\)/);
 assert.match(s,/signal.aborted\|\|!atAllAllowed\(c\)\|\|Date.now\(\)>c.expiresAt/);
 assert.match(s,/atUserId 必须是正整数 QQ 号，且不能为 all/);
 assert.equal(JSON.parse(fs.readFileSync(new URL('config.example.json',root))).groupAtAll.enabled,false);
});
