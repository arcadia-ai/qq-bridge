import test from 'node:test';import assert from 'node:assert/strict';
import {MemoStore} from '../src/memo-store.mjs';
import {contextCommand,selectContext,validateExtraction,ContextMemoService,binanceReference} from '../src/context-memo.mjs';
const now=Date.now(),ctx={scope:'group:1',actor:'2',owner:'3'};
const messages=[{messageId:'10',userId:'2',time:now-1000,text:'项目进度完成80%'},{messageId:'11',userId:'4',time:now-500,text:'别人的消息'}];
const extract=async()=>({lines:[{text:'项目进度完成80%',evidence:[{id:'10',quote:'项目进度完成80%'}]}],trade:false,ambiguous:false});
function fixture(options={}){const memo=new MemoStore(':memory:');return {memo,service:new ContextMemoService({memo,extract,quote:async()=>null,...options})};}
test('context triggers only missing body/references/courtesy; explicit date/batch/query remain old path',()=>{
 for(const s of ['记一下','记一下麻烦你了宝','记住上面','记下刚才那条','帮我记一下，谢谢'])assert.equal(contextCommand(s)?.extract,true,s);
 for(const s of ['记一下我喜欢咖啡','备忘 列表','补记一下 11月2日 例会','记一下 2026-11-04 11:10 记录正文','不要记一下','例如记一下','记一下了吗？'])assert.equal(contextCommand(s),null,s);
 assert.equal(contextCommand('备忘 确认 C-123456abcdef').confirm,'c-123456abcdef');
});
test('history is scoped by real author, freshness, source id and message types',()=>{
 assert.deepEqual(selectContext([...messages,{...messages[0],messageId:'12',isSelf:true},{...messages[0],messageId:'13',time:now-1300000},{...messages[0],messageId:'14',hasForward:true}], '2',now,'99').map(x=>x.messageId),['10']);
});
test('evidence IDs, exact quotes and normalized numbers checked',()=>{
 assert.equal(validateExtraction(awaitable(),messages).content,'项目进度完成80%');
 for(const patch of [{text:'完成99%',evidence:[{id:'10',quote:'项目进度完成80%'}]},{text:'完成80%',evidence:[{id:'11',quote:'项目进度完成80%'}]},{text:'完成80%',evidence:[{id:'10',quote:'fake'}]}])assert.throws(()=>validateExtraction({lines:[patch],trade:false,ambiguous:false},messages));
 function awaitable(){return {lines:[{text:'项目进度完成80%',evidence:[{id:'10',quote:'项目进度完成80%'}]}],trade:false,ambiguous:false};}
});
test('save persists source provenance and idempotence with original timestamp',async()=>{
 const {memo,service}=fixture();try{const r=await service.handle(ctx,'99',{extract:true},messages,now);assert.equal(r.item.recorded,now);assert.equal(r.item.content,'项目进度完成80%');assert.equal((await service.handle(ctx,'99',{extract:true},messages,now)).replayed,true);assert.equal(memo.search(ctx).total,1);}finally{memo.close();}
});
test('ambiguous draft requires same scope+author confirmation, expires, saves once',async()=>{
 const {memo,service}=fixture({extract:async()=>({...await extract(),ambiguous:true})});try{const draft=await service.handle(ctx,'99',{extract:true},messages,now);const cmd=contextCommand(draft.text.split('由你发送：')[1]);assert.ok(cmd);
 await assert.rejects(service.handle({...ctx,actor:'4'},'100',cmd,[],now));await assert.rejects(service.handle({...ctx,scope:'group:9'},'100',cmd,[],now));
 const r=await service.handle(ctx,'100',cmd,[],now);assert.equal(r.committed,true);assert.equal(memo.search(ctx).total,1);
 assert.equal((await service.handle(ctx,'100',cmd,[],now)).replayed,true);
 }finally{memo.close();}
});
test('missing entry becomes market; no fabricated inferred price',async()=>{
 const rows=[{messageId:'10',userId:'2',time:now-1000,text:'某币做多 止损80 止盈100'}];
 const {memo,service}=fixture({extract:async()=>({lines:[{text:rows[0].text,evidence:[{id:'10',quote:rows[0].text}]}],trade:true,entryProvided:false,ambiguous:false})});
 try{const r=await service.handle(ctx,'99',{extract:true},rows,now);assert.match(r.item.content,/入场：市价/);assert.equal(r.item.recorded,now);}finally{memo.close();}
});
test('model failure does not save courtesy or any memo',async()=>{const {memo,service}=fixture({extract:async()=>{throw Error('API unavailable');}});try{await assert.rejects(service.handle(ctx,'99',{extract:true},messages,now));assert.equal(memo.search(ctx).total,0);}finally{memo.close();}});
test('permission revoked during extraction prevents writes',async()=>{let allow=true;const {memo,service}=fixture({allowed:()=>allow,extract:async()=>{allow=false;return await extract();}});try{await assert.rejects(service.handle(ctx,'99',{extract:true},messages,now));assert.equal(memo.search(ctx).total,0);}finally{memo.close();}});
test('Binance uses time-bounded public contract data, rejects future/cross contract guesses',async()=>{
 const calls=[];const fetcher=async u=>{calls.push(String(u));return {ok:true,json:async()=>String(u).includes('exchangeInfo')?{symbols:[{symbol:'BTCUSDT',contractType:'PERPETUAL',status:'TRADING'}]}:[{T:now-5,p:'90000'},{T:now+1,p:'99999'}]};};
 assert.equal((await binanceReference('BTCUSDT',now,{fetcher})).price,'90000');assert.ok(calls[1].includes('endTime='+now));assert.equal(await binanceReference('大饼',now,{fetcher}),null);assert.equal(await binanceReference('BTCUSDT ETHUSDT',now,{fetcher}),null);
});
test('backfill uses original time and write permissions, not latest quote time',async()=>{
 let at;const {memo,service}=fixture({quote:async(text,t)=>{at=t;return {price:'90',symbol:'BTCUSDT',time:t-1,source:'fixture'};}});
 try{const r=memo.write(ctx,'1','save',{content:'BTCUSDT做多\n入场：市价（待回溯）',recorded:now-100000});
 await assert.rejects(service.handle({...ctx,actor:'8'},'2',{backfill:r.item.id},[],now));
 await service.handle(ctx,'3',{backfill:r.item.id},[],now);assert.equal(at,now-100000);assert.equal(memo.row(ctx,r.item.id).recorded,now-100000);assert.match(memo.row(ctx,r.item.id).content,/入场：90/);
 }finally{memo.close();}
});

test('date-only records do not invent a midnight price timestamp',async()=>{
 const {memo,service}=fixture({quote:async()=>{throw Error('must not query');}});
 try{const r=memo.write(ctx,'1','save',{content:'BTCUSDT\n入场：市价',recorded:now-100000,recordPrecision:'date'});
 const result=await service.handle(ctx,'3',{backfill:r.item.id},[],now);assert.match(result.text,/只有日期/);assert.equal(memo.row(ctx,r.item.id).version,1);
 }finally{memo.close();}
});
