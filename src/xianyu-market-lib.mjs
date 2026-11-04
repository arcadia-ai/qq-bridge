export function unwrapPayload(p){
  for(let i=0;i<6;i++){
    if(typeof p==='string'){try{p=JSON.parse(p);continue;}catch{return {};}}
    if(p?.result!==undefined){p=p.result;continue;}break;
  }return p||{};
}
export function remoteFailure(value){
 const text=typeof value==='string'?value:JSON.stringify(value||{});
 const code=/FAIL_SYS_USER_VALIDATE|RGV587_ERROR|验证码|人机验证|风控冷却/.test(text)?'validation_required':
  /FAIL_SYS_SESSION_EXPIRED|FAIL_SYS_LOGIN|FAIL_SYS_TOKEN_(?:EXOIRED|EXPIRED|EMPTY)|令牌过期|登录失效|未登录|未配置闲鱼 Cookie/.test(text)?'login_required':'remote_tool_error';
 const error=Object.assign(Error(code),{code});
 // Keep diagnostic text off enumerable/public data; only the adapter's private redacted log reads it.
 Object.defineProperty(error,'diagnostic',{value:text.slice(0,1500)});
 return error;
}
export function toolPayload(r){
  if(r?.isError)throw remoteFailure(r);
  let p=r?.structuredContent;
  if(!p)for(const b of r?.content||[])if(b.type==='text'){try{p=JSON.parse(b.text);break;}catch{}}
  p=unwrapPayload(p);
  if(p.success===false || p.error || (Array.isArray(p.ret)&&p.ret.some(x=>!/SUCCESS/.test(String(x)))))throw remoteFailure(p);
  return p;
}
// One shared adapter process serves all QQ sessions; refuse overlap instead of queueing forever.
export function createQueryGate({now=Date.now,load=()=>({}),save=()=>{},cooldownMs=1800000}={}){
 let busy=false,state=load()||{};
 return {
  enter(){if(Number(state.until)>now())return 'validation_cooldown';if(busy)return 'busy';busy=true;return null;},
  release(){busy=false;},
  coolDown(reason){state={until:now()+cooldownMs,reason};save(state);}
 };
}
export function clean(value,max=1000){return String(value??'').replace(/<[^>]*>/g,' ').replace(/[\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
export function price(value){
 const s=String(value??'').normalize('NFKC').trim().replace(/^[¥￥]\s*/,'').replace(/元$/,'').replace(/,/g,'').trim();
 const m=/^(\d+(?:\.\d{1,4})?)(万|千|[wk])?$/i.exec(s);
 if(!m||(!m[2]&&(m[1].split('.')[1]||'').length>2))return null;
 const unit=m[2]?.toLowerCase(),scale=unit==='万'||unit==='w'?10000:unit==='千'||unit==='k'?1000:1;
 const amount=Math.round(Number(m[1])*scale*100)/100;
 return Number.isFinite(amount)&&amount>0?amount:null;
}
const compact=s=>String(s).normalize('NFKC').toLowerCase().replace(/[\s\-–—_]/g,'');
const VEHICLE_PARTS=/配件|拆车件|后视镜|车牌架|牌照架|挡泥板|大灯|转向灯|刹车盘|刹车片|车把|手把|离合器|水箱|风挡|脚踏|坐垫|钥匙壳|外壳|车壳|螺丝|维修手册|保养手册|车主手册|用户手册|PDF/i;
export function isVehicleQuery(keyword){
 if(/整车(?!拆|配件|外壳|车壳|改装|螺丝|大线)|整辆/.test(keyword))return true;
 return !VEHICLE_PARTS.test(keyword)&&/川崎|kawasaki|摩托|本田|honda|雅马哈|yamaha|铃木|suzuki|杜卡迪|春风|宝马|\b(?:zx[-\s]?\d|ninja|ktm)/i.test(keyword);
}
function modelTokens(keyword){
 return [...String(keyword).normalize('NFKC').matchAll(/[A-Za-z]+[-_\s]*\d+[A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g)].map(m=>compact(m[0]));
}
function modelPresent(text,model){
 // ZX-4R, ZX 4R and ZX4R are equivalent; ZX4RR is not ZX4R.
 const pattern=[...model].join('[-_\\s]*');
 return new RegExp(pattern+'(?![A-Za-z0-9])','i').test(String(text).normalize('NFKC'));
}
export function compactVehicleQuery(keyword){
 const models=[...new Set(modelTokens(keyword))];
 // Don't silently drop requested years, regions or trim/specification constraints when broadening.
 const rest=String(keyword).normalize('NFKC').replace(/[A-Za-z]+[-_\s]*\d+[A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g,'')
  .replace(/川崎|kawasaki|摩托车|摩托|本田|honda|雅马哈|yamaha|铃木|suzuki|杜卡迪|春风|宝马|ninja|ktm|忍者|整车|整辆|闲鱼|二手|近期|价格|行情|查一下|查询|的/gi,'');
 return isVehicleQuery(keyword)&&models.length===1&&/^[\s\p{P}]*$/u.test(rest)?models[0]:null;
}
export function rejectReason(text,keyword){
 text=clean(text,16000);
 if(/店保(?!养)|本店|店家|批发|渠道货|多台现货|大量现货|支持批量|长期回收|一件代发|仓直发|严选仓|专营|实体店|多色可选|四色可选|三色可选|各个成色价格不同|成色不同价格不同|全新.{0,12}都有货|仅拆.{0,10}几台|京东直发/.test(text))return '明显经营/供货描述';
 if(/加(?:微|v|V)|加微信|[微Vv][信Xx].{0,6}报价|私聊(?:报价|价格)|[订定]金|起拍价|仅供展示|[一1]元起|链接价|拍前询价|单拍不发|引流|以实际报价为准/.test(text))return '引流/订金/不明确报价';
 if(/求购|求收|出租|租赁|日租/.test(text))return '求购或租赁';
 if(isVehicleQuery(keyword)){
  if(/维修手册|保养手册|车主手册|用户手册|电子版|PDF/i.test(text))return '非整车/资料手册';
  if(/标价.{0,4}(?:运费|首付)|仅首付|首付价|分期|置换|所有.{0,8}车型.{0,12}现车/.test(text))return '经营/首付/引流报价';
  if(/拆车件|整车拆件|整车拆配件|拆散出售|原装拆车|价格单个|^.{0,10}(?:适用|适配).{0,60}(?:后视镜|支架|灯|牌照架|外壳|螺丝|风挡|车壳)/.test(text))return '非整车/零部件';
  // Installed mirrors/exhausts are normal. Require whole-vehicle evidence, not "no part words".
  if(!/上牌|行驶|里程|实表|过户|[一二两12]手户|手续齐全|车况|骑腻|[\d.]+\s*(?:w|万|千)?\s*(?:公里|km)|整车出售|整车转让|卖整车/i.test(text))return '未见整车出售依据';
 }
 if(!/服务|降级|刷机|维修|代操作/.test(keyword)&&/远程降级|固件降级|远程指导|代操作|刷机服务|维修服务/.test(text))return '非目标整机/服务';
 // Only obvious accessory-headed listings; mentioning included cables in a full listing is fine.
 if(!/配件|耳罩|耳套|头梁|收纳|包装|充电线|充电头|数据线|保护壳|手机壳/.test(keyword)&&
  /^.{0,24}(?:充电线|充电头|数据线|耳罩|耳套|头梁|保护壳|手机壳|收纳包|包装盒)[、，,（(]/.test(text)&&
  !/配件齐全|附赠|赠送|包含|都在/.test(text))return '非目标整机/单独配件';
 // A normal "未修过" listing is not a repair disclosure.
 const faults=text.replace(/(?:没有|从未|未曾|未|没)(?:维修过|修过|故障)/g,'');
 if(!/故障|维修|配件机|尸体/.test(keyword)&&/故障|接触不良|没声音|无法开机|不通电|尸体|配件机|报废|有裂痕|会修的|维修过|修过/.test(faults))return '故障/维修品';
 const models=modelTokens(keyword);
 if(models.some(m=>!modelPresent(text,m)))return '型号或规格不匹配';
 if(!/配件|耳罩|耳套|收纳|包装|充电线|保护壳/.test(keyword)&&/^(?:只卖|单卖|单出|仅售).{0,10}(?:配件|耳罩|耳套|收纳|包装|充电线|保护壳)/.test(text))return '非目标整机/单独配件';
 return null;
}
export function candidate(item,detail,keyword){
 const data=detail.data||{},d=data.itemDO||{},seller=data.sellerDO||{};
 if(!d.itemId || String(d.itemId)!==String(item.item_id))return {reject:'详情身份未核实'};
 if(/已售|售出|下架|删除/.test(String(d.itemStatusStr||'')) || (d.itemStatus!=null && Number(d.itemStatus)!==0))return {reject:'非在售商品'};
 const title=clean(d.title||item.title,200),description=clean(d.desc||d.richTextDesc||item.title,14000);
 const tags=[...(seller.sellerBizTags||[]),...(seller.sellerInfoTags||[]),...(seller.identityTags||[])].map(t=>clean(t.text||'',80)).join(' ');
 const reject=rejectReason(`${title} ${description} ${tags}`,keyword);
 if(reject)return {reject};
 // Upstream calls the listing's current asking price soldPrice; this is NOT a sold transaction.
 const amount=price(d.soldPrice??item.price);
 if(amount===null)return {reject:'价格不是明确的单个商品标价'};
 const id=String(item.item_id);if(!/^\d+$/.test(id))return {reject:'无有效商品编号'};
 return {item:{id,title,price:amount,currency:'CNY',area:clean(seller.publishCity||seller.city||item.area,40),
   summary:description.slice(0,350),url:`https://www.goofish.com/item?id=${id}`,
   sellerKey:String(seller.sellerId||item.user_nick_name||id),
   screening:'基础过滤通过；未全面核验个人身份',
   caution:Number(seller.itemCount)>50&&Number(seller.hasSoldNumInteger)>200?'卖家交易/商品量较高，需人工复核经营性质':null,
   status:clean(d.itemStatusStr||'在售',20),shipping:clean(d.transportFee,30)}};
}
export function searchCandidate(item,keyword){
 const id=String(item.item_id||'');
 if(!/^\d+$/.test(id))return {reject:'无有效商品编号'};
 const summary=clean(item.title,350);
 const reject=rejectReason(item.title||'',keyword);
 if(reject)return {reject};
 const amount=price(item.price);
 if(amount===null)return {reject:'价格不是明确的单个商品标价'};
 const nick=clean(item.user_nick_name,100).normalize('NFKC').toLowerCase();
 return {item:{id,title:summary.slice(0,100),summary,price:amount,currency:'CNY',
  area:clean(item.area,40),url:`https://www.goofish.com/item?id=${id}`,
  sellerKey:nick?`nick:${nick}`:`item:${id}`,source:'search_summary',
  detailVerified:false,sellerVerified:false,availabilityVerified:false,
  screening:'仅标题/搜索摘要轻筛，未核验详情及个人身份',
  status:'搜索结果展示，未逐条核验在售状态'}};
}
export function summarize(items){
 if(!items.length)return null;
 const a=items.map(x=>x.price).sort((x,y)=>x-y),n=a.length;
 return {basis:'筛选候选的当前在售标价，非成交价、非全市场代表性均价',sampleCount:n,
  mean:Math.round(a.reduce((s,x)=>s+x,0)/n*100)/100,median:n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2,
  min:a[0],max:a[n-1],currency:'CNY',smallSample:n<5};
}
export async function queryMarket({keyword,call,mode='detail'}){
 const queries=[];let searched=0;
 const rejected={},accepted=[],seen=new Set(),sellers=new Set();let checked=0,detailErrors=0;
 const drop=reason=>{rejected[reason]=(rejected[reason]||0)+1;};
 async function consume(query){
  const result=await call('search_items',{keyword:query,page_number:1,rows_per_page:20});
  if(!Array.isArray(result.items))throw Error('invalid_search_response');
  const rows=result.items.slice(0,20);searched+=rows.length;
  queries.push({keyword:query,count:rows.length});
  for(const item of rows){
  const id=String(item.item_id||'');if(!/^\d+$/.test(id)||seen.has(id))continue;seen.add(id);
  const early=rejectReason(item.title||'',keyword);if(early){drop(early);continue;}
  if(accepted.length>=5)continue;
  let c;
  if(mode==='search-summary'){
   c=searchCandidate(item,keyword);
  }else{
   if(checked>=8)continue;checked++;
   let detail;try{detail=await call('get_item_detail',{item_id:id});}catch(error){
    // Risk/login failures affect the whole account, not just this listing. Never try the next 7.
    if(['validation_required','login_required'].includes(error.code))throw error;
    detailErrors++;continue;
   }
   c=candidate(item,detail,keyword);
  }
  if(c.reject){drop(c.reject);continue;}
  if(sellers.has(c.item.sellerKey)){drop('同一卖家重复');continue;}sellers.add(c.item.sellerKey);accepted.push(c.item);
  }
 }
 await consume(keyword);
 // Only a bounded model simplification for whole-vehicle searches; no unbounded retries/pages.
 if(mode==='search-summary'&&accepted.length<3){
  const fallback=compactVehicleQuery(keyword);
  if(fallback&&fallback!==String(keyword).trim().toLowerCase())await consume(fallback);
 }
 const statistics=summarize(accepted);
 if(statistics&&mode==='search-summary')statistics.basis='本次搜索摘要候选的在售标价，未核验详情，非成交价、非全市场均价';
 const limitations=mode==='search-summary'?
  ['仅依据标题/搜索摘要轻筛，未读取商品详情，未核验个人身份或完整卖家历史。',
   '标价来自搜索结果，未逐条核验在售状态/完整成色/真实报价；不含成交价。',
   '商品与可见卖家昵称去重，昵称不是稳定身份核验。官方详情格式链接，QQ跳转效果以实际为准。']:
  ['仅基础过滤，未核验完整卖家历史，候选不保证为个人账号。','结果仅本次搜索样本的在售标价；不包含成交价。','商品详情已读取，QQ客户端打开链接的效果仍以实际为准。'];
 return {ok:true,mode,keyword,queriedAt:new Date().toISOString(),timeZone:'Asia/Shanghai',
  searched,searchCount:queries.length,queries,detailsChecked:checked,detailErrors,filtered:rejected,
  statistics,candidates:accepted.map(({sellerKey,...item})=>item),limitations};
}
