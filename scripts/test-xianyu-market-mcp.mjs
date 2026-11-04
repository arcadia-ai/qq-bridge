// Real stdio adapter against local fixtures. No real Xianyu requests or credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {z} from 'zod';

async function fixture(failSearch,vehicle=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xianyu-adapter-test-'));
 let searches=0,details=0,client;
 const remote=new McpServer({name:'xianyu-fixture',version:'1'});
 remote.tool('search_items',{keyword:z.string(),page_number:z.number(),rows_per_page:z.number()},async()=>{
  searches++;
  if(failSearch)return {isError:true,content:[{type:'text',text:'FAIL_SYS_USER_VALIDATE'}]};
  if(vehicle)return {structuredContent:{result:JSON.stringify({items:searches===1?
   [{item_id:'122',title:'川崎ZX4R维修手册PDF',price:'13'}]:
   [{item_id:'123',title:'24年川崎ZX4R个人一手户，上牌一年，8000公里',price:'¥2.90万'}]})},content:[]};
  return {structuredContent:{result:JSON.stringify({items:[{item_id:'123',title:'WH-1000XM5 个人闲置',price:'900'}]})},content:[]};
 });
 remote.tool('get_item_detail',{item_id:z.string()},async()=>{
  details++;throw Error('Summary mode must NEVER call this tool');
 });
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID()});
 await remote.connect(transport);
 const httpServer=http.createServer((req,res)=>{
  transport.handleRequest(req,res).catch(()=>{if(!res.headersSent){res.statusCode=500;res.end();}});
 });
 await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));
 const config=path.join(dir,'config.private.json');
 fs.writeFileSync(config,JSON.stringify({url:`http://127.0.0.1:${httpServer.address().port}/mcp`}),{mode:0o600});
 async function start(){
  client=new Client({name:'adapter-fixture-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('src/xianyu-market-mcp.mjs')],env:{...process.env,XIANYU_MCP_CONFIG:config}}));
 }
 async function query(){
  return client.callTool({name:'xianyu_market_query',arguments:{keyword:vehicle?'川崎 ZX-4R':'WH-1000XM5'}},undefined,{timeout:30000});
 }
 try{
  await start();
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['xianyu_market_query']);
  const first=await query(),p=JSON.parse(first.content[0].text);
  if(failSearch){
   assert.equal(first.isError,true);assert.equal(p.code,'validation_required');
   assert.equal(JSON.parse((await query()).content[0].text).code,'validation_cooldown');
   await client.close();await start();
   assert.equal(JSON.parse((await query()).content[0].text).code,'validation_cooldown');
   assert.equal(fs.statSync(path.join(dir,'xianyu-market-search-state.json')).mode&0o777,0o600);
  }else{
   assert.ok(!first.isError);assert.equal(p.mode,'search-summary');
   assert.equal(p.candidates[0].url,'https://www.goofish.com/item?id=123');
   assert.equal(p.candidates[0].detailVerified,false);assert.equal(p.statistics.mean,vehicle?29000:900);
  }
  assert.equal(searches,vehicle?2:1);assert.equal(details,0);
  console.log(`SUMMARY_ADAPTER_FIXTURE_OK: ${failSearch?'search validation/cooldown/restart':'success/limits/links'}; zero detail calls.`);
 }finally{
  await client?.close().catch(()=>{});await remote.close().catch(()=>{});
  await new Promise(resolve=>httpServer.close(resolve));
  fs.rmSync(dir,{recursive:true,force:true});
 }
}
await fixture(false);
await fixture(true);
await fixture(false,true);
