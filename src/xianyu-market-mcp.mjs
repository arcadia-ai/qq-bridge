import fs from 'node:fs';
import path from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {z} from 'zod';
import {queryMarket,toolPayload,remoteFailure,createQueryGate} from './xianyu-market-lib.mjs';
const configFile=process.env.XIANYU_MCP_CONFIG || path.join(process.env.DSH_HOME||'', 'xianyu-mcp.private.json');
// Details remain disabled. Their existing cooldown file is retained, not reused/cleared here.
const stateFile=path.join(path.dirname(configFile),'xianyu-market-search-state.json');
const logFile=path.join(path.dirname(configFile),'xianyu-market.log');
function note(event){
 try{
  let lines=[];try{lines=fs.readFileSync(logFile,'utf8').split('\n').filter(Boolean).slice(-19);}catch{}
  lines.push(JSON.stringify({at:new Date().toISOString(),...event}));
  fs.writeFileSync(logFile,lines.join('\n')+'\n',{mode:0o600});fs.chmodSync(logFile,0o600);
 }catch{console.error('xianyu_private_log_write_failed');}
}
function diagnostic(error,config){
 let text=String(error.diagnostic||error.message||'');
 for(const value of Object.values(config?.headers||{}))if(value)text=text.split(value).join('[REDACTED]');
 return text.replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]').replace(/((?:cookie|authorization|access_?token|secret)[\s"':=]+)[^\s,;}]+/gi,'$1[REDACTED]').slice(0,500);
}
const gate=createQueryGate({
 load(){try{return JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{return {}; }},
 save(state){try{fs.writeFileSync(`${stateFile}.tmp`,JSON.stringify(state),{mode:0o600});fs.renameSync(`${stateFile}.tmp`,stateFile);}catch{console.error('xianyu_cooldown_state_save_failed');}}
});
const server=new McpServer({name:'xianyu-market-readonly',version:'1.1.1'});
const failure=(code,message)=>({isError:true,content:[{type:'text',text:JSON.stringify({ok:false,code,message,retry:false})}]});
server.tool('xianyu_market_query','闲鱼搜索摘要模式：通常搜索20条，整车候选不足时最多一次简化型号补搜（共最多40条），轻筛后返回最多5个标价与链接，支持万/千价格单位。不请求详情，未核验个人身份/逐条在售状态，不是成交价。只传用户给的公开品牌型号及必要规格，不自动扩写长句，不传QQ号/群号/聊天历史；规格不明确先询问。',
 {keyword:z.string().trim().min(2).max(120)},async({keyword})=>{
  if(/Bearer|sk-|\[CQ:|https?:|\d{8,}|QQ号|群号|聊天记录/i.test(keyword))return {isError:true,content:[{type:'text',text:'请仅提供物品型号与必要规格，不发送账号、链接、凭据或聊天记录。'}]};
  const blocked=gate.enter();
  if(blocked)return failure(blocked,blocked==='busy'?'另一条闲鱼查询正在执行，请稍后由用户重新发起，不要自动重试。':'闲鱼接口要求验证或重新登录，查询处于30分钟冷却保护期。本次没有请求上游；不要换关键词重试，请主人检查闲鱼服务。');
  const remote=new Client({name:'bigfish-xianyu-readonly',version:'1.0.0'});
  let config,phase='configuration';const started=Date.now();
  try{
   config=JSON.parse(fs.readFileSync(configFile,'utf8'));phase='connect';
   await remote.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}}),{timeout:25000});
   const call=async(name,args)=>{
    if(name!=='search_items')throw Error('search_summary_only');
    phase=name;
    return toolPayload(await remote.callTool({name,arguments:args},undefined,{timeout:60000}));
   };
   const result=await queryMarket({keyword,call,mode:'search-summary'});
   note({event:'query_success',mode:result.mode,elapsedMs:Date.now()-started,searched:result.searched,candidates:result.candidates.length,detailsChecked:result.detailsChecked});
   return {content:[{type:'text',text:JSON.stringify(result)}]};
  }catch(error){
   const code=['validation_required','login_required'].includes(error.code)?error.code:remoteFailure(error.diagnostic||error.message).code;
   console.error('xianyu_market_query_failed',code);
   note({event:'query_failed',phase,code,errorName:error.name,elapsedMs:Date.now()-started,diagnostic:diagnostic(error,config)});
   if(['validation_required','login_required'].includes(code)){
    gate.coolDown(code);
    return failure(code,'闲鱼搜索接口要求验证或重新登录，已停止请求并冷却30分钟。手机端不一定有提示，请主人检查服务端账号状态。不要自动重试，不要编造标价或候选链接。');
   }
   return failure('query_failed','闲鱼实时查询失败，本次未取得可核实行情。请稍后由用户重新发起或由主人检查服务；不要自动反复查询，不编造价格或候选。');
  }finally{await remote.close().catch(()=>{});gate.release();}
 });
await server.connect(new StdioServerTransport());
