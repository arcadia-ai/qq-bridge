import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GroupSummaryService,MAX_AGE,normalizeMessage,matchMember,validateRange,relativeRange,summaryIntent,plainSummaryLine,summaryPoints,renderSummary} from '../src/group-summary.mjs';
const now=Date.now(),g='1';
const event=(text='总结一下贝爷今天的发言',extra={})=>({group_id:1,user_id:2,self_id:9,time:Math.floor(now/1000),message_id:10,message:[{type:'at',data:{qq:9}},{type:'text',data:{text}}],sender:{card:'测试成员'},...extra});
const request={target:'贝爷',start:new Date(now-60000).toISOString(),end:new Date(now).toISOString(),topic:'',needsClarification:false};
function fixture(options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'group-summary-test-'));const calls=[],inputs=[];const s=new GroupSummaryService({file:path.join(dir,'history.db'),now:()=>now,selfQQ:()=>9,allowed:options.allowed||(()=>true),call:options.call|| (async(a,p)=>{calls.push([a,p]);return a==='get_group_member_list'?[{user_id:2,card:'贝爷'}]:{messages:[event('讨论测试事项',{time:Math.floor((now-30000)/1000),message_id:11})]};}),model:options.model|| (async(sys,input,json)=>{inputs.push(input);return json?(input.request!==undefined?request:{points:['测试事项摘要']}):'测试事项摘要';})});return {s,dir,calls,inputs,close(){s.close();fs.rmSync(dir,{recursive:true,force:true});}};}
test('natural language triggers, note commands excluded',()=>{for(const s of ['总结贝爷今天的发言','回顾一下昨天聊了什么','汇总今天讨论的硬件话题'])assert.ok(summaryIntent(s));assert.equal(summaryIntent('记一下 总结功能上线'),false);});
test('message archive accepts only matching group, valid time and IDs',()=>{assert.ok(normalizeMessage(event(),g,now));assert.equal(normalizeMessage(event(), '3',now),null);assert.equal(normalizeMessage(event(undefined,{time:0}),g,now),null);assert.equal(normalizeMessage(event(undefined,{message_id:0}),g,now),null);});
test('member exact/card/substring matching resolves IDs, ambiguity not guessed',()=>{const list=[{user_id:2,card:'贝爷',nickname:'小贝'},{user_id:3,card:'阿毛'}];assert.equal(matchMember('贝爷',list).id,'2');assert.equal(matchMember('小贝',list).id,'2');assert.equal(matchMember(null,list),null);assert.throws(()=>matchMember('贝爷',[...list,{user_id:4,card:'贝爷'}]));assert.throws(()=>matchMember('未知',list));});
test('72h maximum/future/date ambiguity fail closed',()=>{assert.equal(validateRange(request,now).end,now);for(const p of [{start:new Date(now-MAX_AGE-120000).toISOString()},{end:new Date(now+120000).toISOString()},{start:'今天'},{needsClarification:true}])assert.throws(()=>validateRange({...request,...p},now));});
test('summary uses only target group+user and original time window',async()=>{const f=fixture();try{f.s.ingest(event('别人发言',{group_id:3,message_id:12,user_id:4}));const r=await f.s.run(event(),'总结贝爷');assert.match(r.text,/群聊简报｜贝爷/);assert.match(r.text,/记录不全/);assert.equal(f.inputs[1].messages.length,1);assert.match(f.inputs[1].messages[0].text,/讨论测试事项/);}finally{f.close();}});
test('whole-group query needs no target nickname',async()=>{const f=fixture({model:async(s,i,json)=>json?(i.request!==undefined?{...request,target:null}:{points:['全群话题']}):'全群话题'});try{assert.match((await f.s.run(event(),'总结今天群聊')).text,/群聊简报｜全群/);}finally{f.close();}});
test('72h retention purges old rows, excludes bot own summary',()=>{const f=fixture();try{f.s.ingest(event('bot',{user_id:9}));assert.equal(f.s.db.prepare('SELECT count(*) n FROM messages').get().n,0);f.s.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run('1','99','2',now-MAX_AGE-1,'a','old',0);f.s.cleanup();assert.equal(f.s.db.prepare('SELECT count(*) n FROM messages').get().n,0);}finally{f.close();}});
test('duplicate source never sends two delivered summaries',async()=>{const f=fixture();try{await f.s.run(event(),'总结');f.s.delivered(1,10);assert.equal((await f.s.run(event(),'总结')).duplicate,true);}finally{f.close();}});
test('permission changes during parsing prevent history/model access',async()=>{let allowed=true;const f=fixture({allowed:()=>allowed,model:async()=>{allowed=false;return request;}});try{await assert.rejects(f.s.run(event(),'总结'));assert.equal(f.calls.length,0);}finally{f.close();}});
test('multiple real targets and conflicting name/mention are rejected',async()=>{const f=fixture();try{const e=event();e.message.push({type:'at',data:{qq:2}},{type:'at',data:{qq:3}});await assert.rejects(f.s.run(e,'总结'));}finally{f.close();}});
test('empty/inaccessible history explicitly reports limited evidence, not no speech',async()=>{const f=fixture({call:async a=>a==='get_group_member_list'?[{user_id:2,card:'贝爷'}]:{messages:[]}});try{assert.match((await f.s.run(event(),'总结')).text,/不代表实际没有发言/);}finally{f.close();}});
test('archive dedup and request rate limit hold',async()=>{const f=fixture();try{f.s.ingest(event());f.s.ingest(event());assert.equal(f.s.db.prepare('SELECT count(*) n FROM messages').get().n,1);for(let i=1;i<=3;i++)await f.s.run(event(undefined,{message_id:100+i}),'总结');await assert.rejects(f.s.run(event(undefined,{message_id:104}),'总结'),/每小时/);}finally{f.close();}});

test('recall purges archive and prevents historical replay reintroduction',()=>{const f=fixture();try{f.s.ingest(event());f.s.recall(1,10);f.s.ingest(event());assert.equal(f.s.db.prepare('SELECT count(*) n FROM messages').get().n,0);}finally{f.close();}});

test('dispatch is durable and uncertain sends are not automatically repeated',async()=>{const f=fixture();try{await f.s.run(event(),'总结');f.s.dispatch(1,10);assert.equal((await f.s.run(event(),'总结')).duplicate,true);assert.throws(()=>f.s.dispatch(1,10));}finally{f.close();}});

test('colloquial speech variants route to summaries without requiring the word 总结',()=>{
 for(const text of ['今天群里说了些啥','今天大家聊了些什么','今天小鱼儿说了什么','贝爷今天讲了哪些事','贝爷说了些啥','大家昨天都聊了点什么','近三天群里讨论过哪些话题','今天群里有哪些话题','帮我看看小鱼儿今天都说了啥','请回顾今天群里的讨论','能不能总结一下今天的群聊','今天群里说了些啥？'])assert.equal(summaryIntent(text),true,text);
});
test('routing excludes negation, examples, notes and capability questions',()=>{
 for(const text of ['不要总结今天群聊','我不需要总结','今天不想总结','今天不用总结了','先不回顾群聊','停止总结','不要告诉我今天群里聊了什么','例如：今天群里说了些啥','比如我会问今天群里说了些啥','假设今天大家聊了些什么','记一下今天群里说了些啥','备忘 总结功能上线','“今天群里说了些啥”','你有群聊总结功能吗','群聊总结怎么用','你好啊','你说了什么','你刚才说了啥'])assert.equal(summaryIntent(text),false,text);
});
test('screenshot request enters dedicated history summary flow and returns coverage header',async()=>{
 const f=fixture({model:async(sys,input,json)=>json?(input.request!==undefined?{...request,target:null}:{points:['今日主要讨论了测试事项。']}):'今日主要讨论了测试事项。'});
 try{const e=event('今天群里说了些啥');assert.equal(summaryIntent(e.message[1].data.text),true);
 const r=await f.s.run(e,e.message[1].data.text);assert.match(r.text,/群聊简报｜全群/);assert.match(r.text,/北京时间/);assert.match(r.text,/注：/);assert.ok(f.calls.some(([a])=>a==='get_group_msg_history'));
 }finally{f.close();}
});

test('common relative windows use Beijing midnight instead of model timezone arithmetic',()=>{
 const at=Date.parse('2026-11-06T11:35:00+08:00'),wrong={...request,start:'2026-11-05T08:00:00Z',end:new Date(at).toISOString()};
 for(const [q,start,end] of [['今天群里说了些啥','2026-11-05T16:00:00Z',new Date(at).toISOString()],['昨天贝爷说了些什么','2026-11-04T16:00:00Z','2026-11-05T16:00:00Z'],['贝爷的发言总结','2026-11-05T16:00:00Z',new Date(at).toISOString()]]){
 const r=relativeRange(wrong,q,at);assert.equal(Date.parse(r.start),Date.parse(start));assert.equal(Date.parse(r.end),Date.parse(end));}
 assert.equal(Date.parse(relativeRange(wrong,'近三天的群聊',at).start),at-MAX_AGE);
 assert.deepEqual(relativeRange(wrong,'今天上午的群聊',at),wrong);
 assert.deepEqual(relativeRange(wrong,'总结2026-11-05的群聊',at),wrong);
 assert.deepEqual(relativeRange({...wrong,needsClarification:true},'今天聊了啥',at),{...wrong,needsClarification:true});
});

test('plaintext renderer strips Markdown and preserves important numbers',()=>{
 const points=summaryPoints({points:['**止损2193，止盈2280–2350**','## 周五11:30确认安排','`2 * 3 * 4`']});
 assert.equal(points[0],'止损2193，止盈2280–2350');assert.equal(points[1],'周五11:30确认安排');assert.equal(points[2],'2 * 3 * 4');assert.equal(plainSummaryLine('_重点_：BTC_USDT'),'重点：BTC_USDT');assert.throws(()=>summaryPoints({points:['```未闭合']}));
 const text=renderSummary({target:'全群',start:now-60000,end:now,rows:[{t:now-30000}],points,complete:false,limited:true,truncated:true});
 assert.ok(!text.includes('**'));assert.ok(!text.includes('##'));assert.ok(!text.includes('`'));assert.match(text,/仅部分记录/);assert.match(text,/长消息有截断/);assert.match(text,/记录不全/);assert.match(text,/1、止损2193/);
});
test('renderer deduplicates and rejects oversized summaries rather than truncating facts',()=>{
 assert.deepEqual(summaryPoints({points:['讨论了安排。','讨论了安排。']}),['讨论了安排。']);
 for(const data of [{points:[]},{points:Array(5).fill('abc')},{points:['长'.repeat(101)]},{points:['甲'.repeat(90),'乙'.repeat(90),'丙'.repeat(90)]}])assert.throws(()=>summaryPoints(data));
});
test('low-information chat need not invent conclusions or pad points',()=>{
 assert.deepEqual(summaryPoints({points:['主要是午饭和上班日常闲聊，没有形成明确安排。']}),['主要是午饭和上班日常闲聊，没有形成明确安排。']);
});
test('model final output is JSON and valid points render as short text',async()=>{
 const f=fixture({model:async(sys,input,json)=>input.request!==undefined?{...request,target:null}:{points:['**大家讨论周五的读书分享，时间尚未确定。**']}});
 try{const r=await f.s.run(event(),'今天群里说了些啥');assert.match(r.text,/1、大家讨论周五/);assert.ok(!r.text.includes('**'));assert.ok(r.text.length<400);}finally{f.close();}
});
test('invalid final output gets at most one repair before failing safely',async()=>{
 let calls=0;const f=fixture({model:async(sys,input,json)=>{if(input.request!==undefined)return request;calls++;return {points:['长'.repeat(101)]};}});
 try{await assert.rejects(f.s.run(event(),'总结贝爷'),/过长/);assert.equal(calls,2);}finally{f.close();}
});
