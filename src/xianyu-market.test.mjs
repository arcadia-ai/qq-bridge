import test from 'node:test';
import assert from 'node:assert/strict';
import {unwrapPayload,toolPayload,price,rejectReason,candidate,searchCandidate,queryMarket,summarize,createQueryGate,compactVehicleQuery} from './xianyu-market-lib.mjs';
const keyword='索尼 WH-1000XM5';
const row=(id='1')=>({item_id:id,title:'个人闲置 索尼 WH-1000XM5',price:'¥880'});
const detail=(id='1',seller='s1',extra={})=>({data:{itemDO:{itemId:id,title:'索尼 WH-1000XM5',desc:'个人自用，未修过，功能正常',soldPrice:'880',itemStatus:0,itemStatusStr:'在线',...extra},sellerDO:{sellerId:seller}}});

test('unwrap actual MCP wrappers and reject business errors',()=>{
 assert.deepEqual(unwrapPayload({result:JSON.stringify({items:[]})}),{items:[]});
 assert.equal(toolPayload({content:[{type:'text',text:JSON.stringify({result:'{"items":[1]}'})}]}).items.length,1);
 assert.throws(()=>toolPayload({isError:true}));
 assert.throws(()=>toolPayload({structuredContent:{ret:['FAIL_SYS_LOGIN']}}));
 assert.throws(()=>toolPayload({isError:true,content:[{type:'text',text:'FAIL_SYS_TOKEN_EXOIRED::令牌过期'}]}),e=>e.code==='login_required');
 assert.deepEqual(toolPayload({structuredContent:{ret:['SUCCESS::调用成功']}}).ret,['SUCCESS::调用成功']);
});
test('only unambiguous positive asking prices',()=>{
 for(const v of ['¥1,200','￥1200元',1200])assert.equal(price(v),1200);
 for(const v of ['',0,'1元起','800-1000','定金100',-1,null])assert.equal(price(v),null);
});
test('light filtering rejects obvious merchants, bait, faults, wrong model and accessories',()=>{
 for(const text of ['WH-1000XM5 本店 店保180天','WH-1000XM5 私聊报价','WH-1000XM5 左边没声音','WF-1000XM5 自用','只卖WH-1000XM5耳罩'])assert.ok(rejectReason(text,keyword),text);
 for(const text of ['WH-1000XM5 全新未拆 自用礼物','WH-1000XM5 未修过，正常使用，欢迎私聊','WH-1000XM5 没有维修过'])assert.equal(rejectReason(text,keyword),null,text);
 assert.equal(rejectReason('WH-1000XM5故障机','WH-1000XM5 故障'),null);
});
test('detail identity, availability and asking-price fields',()=>{
 assert.equal(candidate(row(),detail(),keyword).item.price,880);
 assert.ok(candidate(row(),detail('2'),keyword).reject);
 assert.ok(candidate(row(),detail('1','s1',{itemStatus:1,itemStatusStr:'已售出'}),keyword).reject);
 assert.ok(candidate(row(),detail('1','s1',{soldPrice:'200起'}),keyword).reject);
});
test('candidate cap, dedup and privacy',async()=>{
 const calls=[];
 const result=await queryMarket({keyword,call:async(name,args)=>{
  calls.push(name);
  if(name==='search_items'){assert.equal(args.rows_per_page,20);return {items:[row('1'),row('1'),...Array.from({length:19},(_,i)=>row(String(i+2)))]};}
  return detail(args.item_id,args.item_id==='2'?'1':args.item_id);
 }});
 assert.equal(result.candidates.length,5);assert.equal(result.detailsChecked,6);
 assert.equal(result.filtered['同一卖家重复'],1);
 assert.equal(result.statistics.mean,880);
 assert.equal(JSON.stringify(result).includes('sellerKey'),false);
 assert.ok(calls.every(n=>['search_items','get_item_detail'].includes(n)));
});
test('at most eight details; handle partial failures and no valid results',async()=>{
 const r=await queryMarket({keyword,call:async name=>{
  if(name==='search_items')return {items:Array.from({length:20},(_,i)=>row(String(i+1)))};
  throw Error('private transport error');
 }});
 assert.equal(r.detailsChecked,8);assert.equal(r.detailErrors,8);assert.equal(r.statistics,null);
 assert.equal(JSON.stringify(r).includes('private transport error'),false);
 assert.equal(summarize([]),null);
 assert.equal(summarize([{price:800},{price:1000}]).median,900);
});
test('validation stops the first detail, rather than retrying the whole batch',async()=>{
 let calls=0;
 await assert.rejects(queryMarket({keyword,call:async name=>{
  if(name==='search_items')return {items:[row('1'),row('2')]};
  calls++;return toolPayload({isError:true,content:[{type:'text',text:'Error executing tool: FAIL_SYS_USER_VALIDATE'}]});
 }}),e=>e.code==='validation_required');
 assert.equal(calls,1);
});
test('shared busy guard and persisted validation cooldown',()=>{
 let clock=1000,saved;
 const gate=createQueryGate({now:()=>clock,save:s=>{saved=s;},cooldownMs:5000});
 assert.equal(gate.enter(),null);assert.equal(gate.enter(),'busy');
 gate.coolDown('validation_required');gate.release();
 assert.equal(gate.enter(),'validation_cooldown');
 const restarted=createQueryGate({now:()=>clock,load:()=>saved});
 assert.equal(restarted.enter(),'validation_cooldown');
 clock=6001;assert.equal(gate.enter(),null);gate.release();
});
test('search summaries carry explicit evidence limits',()=>{
 const c=searchCandidate({...row(),area:'上海',user_nick_name:'示例昵称'},keyword).item;
 assert.equal(c.price,880);assert.equal(c.source,'search_summary');
 assert.equal(c.detailVerified,false);assert.equal(c.sellerVerified,false);assert.equal(c.availabilityVerified,false);
 assert.equal(c.url,'https://www.goofish.com/item?id=1');
 assert.ok(searchCandidate({...row(),price:'100元起'},keyword).reject);
});
test('summary mode makes exactly one search, zero details, capped and deduplicated',async()=>{
 const calls=[];
 const result=await queryMarket({keyword,mode:'search-summary',call:async(name,args)=>{
  calls.push(name);assert.equal(name,'search_items');assert.equal(args.rows_per_page,20);
  return {items:[{...row('1'),user_nick_name:'同一昵称'},{...row('2'),user_nick_name:'同一昵称'},
   {...row('3'),title:'WH-1000XM5 本店店保'},...Array.from({length:25},(_,i)=>row(String(i+4)))]};
 }});
 assert.deepEqual(calls,['search_items']);assert.equal(result.mode,'search-summary');
 assert.equal(result.searched,20);assert.equal(result.detailsChecked,0);assert.equal(result.detailErrors,0);
 assert.equal(result.candidates.length,5);assert.equal(result.filtered['同一卖家重复'],1);
 assert.ok(result.statistics.basis.includes('未核验详情'));
 assert.equal(JSON.stringify(result).includes('同一昵称'),false);assert.equal(JSON.stringify(result).includes('sellerKey'),false);
});
test('summary mode propagates search validation and handles empty results',async()=>{
 await assert.rejects(queryMarket({keyword,mode:'search-summary',call:async()=>toolPayload({isError:true,content:[{type:'text',text:'FAIL_SYS_USER_VALIDATE'}]})}),e=>e.code==='validation_required');
 const r=await queryMarket({keyword,mode:'search-summary',call:async()=>({items:[]})});
 assert.equal(r.statistics,null);assert.deepEqual(r.candidates,[]);assert.equal(r.detailsChecked,0);
});
test('summary filtering excludes obvious services/accessory heads, not included accessories',()=>{
 for(const text of ['索尼WH1000-XM5远程降级，远程指导代操作','索尼原装充电线、充电头（适配wh-1000xm5）'])assert.ok(rejectReason(text,keyword));
 assert.equal(rejectReason('索尼 WH-1000XM5 配件齐全，原装包装盒、说明书、充电线都在',keyword),null);
 assert.equal(rejectReason('WH-1000XM5 固件降级远程服务','WH-1000XM5 固件降级'),null);
 assert.equal(rejectReason('索尼充电线、充电头WH-1000XM5','WH-1000XM5 充电线'),null);
});
test('prices with ten-thousand/thousand units are parsed, not dropped',()=>{
 for(const [s,n] of [['¥2.90万',29000],['￥3.88万元',38800],['1.2千元',1200],['3.5w',35000],['2K',2000],['1.2345万',12345]])assert.equal(price(s),n,s);
 for(const s of ['2.9万起','首付0.5万','2万-3万','1.234','¥0万'])assert.equal(price(s),null,s);
});
test('whole vehicle excludes manuals/parts/deposits and preserves installed accessories',()=>{
 const k='川崎 ZX-4R';
 for(const s of ['川崎ZX4R维修手册，中文PDF','川崎ZX4R原厂后视镜一对，几百公里拆车件','适用川崎ZX4R大灯支架','川崎ZX4R行驶100公里，标价是运费','川崎ZX4R行驶100公里，首付价5000'])assert.ok(rejectReason(s,k),s);
 assert.equal(rejectReason('24年川崎ZX4R，个人2手户，实表8000km，装了风挡、脚踏和手机支架',k),null);
 assert.equal(rejectReason('川崎ZX-4R 车商勿扰，个人自用，上牌一年，无事故，4s店保养',k),null);
 assert.equal(rejectReason('川崎ZX4R后视镜一对99包邮','川崎ZX4R后视镜'),null);
});
test('model matching handles separators without conflating R and RR',()=>{
 for(const m of ['ZX-4R','ZX 4R','zx4r'])assert.equal(rejectReason(`川崎${m}，个人一手户，上牌一年`,'川崎 ZX-4R'),null);
 assert.ok(rejectReason('川崎ZX4RR，个人一手户，上牌一年','川崎 ZX-4R'));
 assert.equal(compactVehicleQuery('川崎 zx-4r'),'zx4r');
 assert.equal(compactVehicleQuery('川崎 zx4r 后视镜'),null);
 assert.equal(compactVehicleQuery('2024年 湖北 川崎 zx4r'),null);
 assert.equal(compactVehicleQuery('川崎 zx4r KRT'),null);
});
test('whole-vehicle summaries compact the model at most once, zero details',async()=>{
 const calls=[];
 const r=await queryMarket({keyword:'川崎 ZX-4R',mode:'search-summary',call:async(name,args)=>{
  calls.push({name,keyword:args.keyword});assert.equal(name,'search_items');
  if(calls.length===1)return {items:[{item_id:'1',title:'川崎ZX4R维修手册PDF',price:'13'},{item_id:'2',title:'川崎ZX4R后视镜一对拆车件',price:'99'}]};
  return {items:[{item_id:'3',title:'24年川崎ZX4R，个人2手户，实表8000km',price:'¥2.90万'},{item_id:'4',title:'川崎ZX4R个人自用，上牌一年，装了风挡和手机支架',price:'¥3.60万'}]};
 }});
 assert.deepEqual(calls.map(c=>c.keyword),['川崎 ZX-4R','zx4r']);
 assert.equal(r.searchCount,2);assert.equal(r.searched,4);assert.equal(r.detailsChecked,0);
 assert.equal(r.candidates.length,2);assert.equal(r.statistics.min,29000);assert.equal(r.statistics.mean,32500);
 const single=await queryMarket({keyword:'zx4r',mode:'search-summary',call:async()=>({items:[]})});
 assert.equal(single.searchCount,1);assert.equal(single.statistics,null);
});
