import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoStore,parseMemo,memoReply} from '../src/memo-store.mjs';

const entries=[
 '1月5日：读书讨论，主题 A、B，地点 C',
 '2月6日：检查文档，章节 A、B，版本 C',
 '2月6日：安排例会，议题 A、B，会议室 C',
 '2月6日 20:43：1200字摘要，章节 A，页码 20–30',
 '2月7日 19:39：审阅报告，附件 A、B，版本 C'
];
test('batch fixture, bullets/newlines/inline delimiters, date precision and transaction',()=>{
 for(const input of ['补记一下- '+entries.join('\n- '),'补记 '+entries.join('\n'),'补记一下前面几条 '+entries.join('；'),'补记 '+entries.join(' ')]){
  const parsed=parseMemo(input);assert.equal(parsed.action,'batchSave');assert(!parsed.batchError,parsed.batchError);assert.equal(parsed.items.length,5);
  const s=new MemoStore(':memory:'),ctx=s.context('group:123','10','1',true);
  const r=s.write(ctx,'batch',parsed.action,parsed);
  assert.equal(r.items.length,5);assert.equal(r.items[0].recordedAt,'2026-01-05');assert.equal(r.items[1].recordedAt,'2026-02-06');
  assert.equal(r.items[3].recordedAt,'2026-02-06 20:43:00');assert.equal(r.items[4].recordedAt,'2026-02-07 19:39:00');
  assert.equal(r.items[3].content,'1200字摘要，章节 A，页码 20–30');
  assert.equal(r.items[0].content,'读书讨论，主题 A、B，地点 C');
  assert.equal(new Set(r.items.map(x=>x.id)).size,5);assert.match(memoReply(r,ctx.scope),/已补记 5 条/);
  assert(!memoReply(r,ctx.scope).includes('2026-01-05 00:00'));
  assert.equal(s.write(ctx,'batch',parsed.action,parsed).replayed,true);assert.equal(s.search(ctx,'').total,5);
  const member=s.context('group:123','20','1',true),other=s.context('group:456','20','1',true);
  assert.equal(s.search(member,'').total,5);assert.equal(s.search(other,'').total,0);
  assert.throws(()=>s.write(member,'edit','update',{id:r.items[0].id,content:'篡改'}));s.close();
 }
});
test('invalid dates, incomplete last item, missing dates and quota overflow roll back entire batch',()=>{
 const s=new MemoStore(':memory:'),ctx=s.context('private:1','1','1',true);
 for(const text of ['补记 2月6日：有效 2月7日 19:39：测试条目，止盈','补记 2月6日：有效 2月30日：错误','补记 2月6日 24:10：时间错误','补记 2月6日 20:4：时间不完整','补记 测试内容','补记 2月6日：']){
  const parsed=parseMemo(text);assert(parsed.batchError,text);assert.throws(()=>s.write(ctx,text,parsed.action,parsed),/备忘/);assert.equal(s.search(ctx,'').total,0);
 }
 const cmd=parseMemo('补记 2月6日：有效 2月7日：'+ 'x'.repeat(10001));
 assert.throws(()=>s.write(ctx,'oversize',cmd.action,cmd));assert.equal(s.search(ctx,'').total,0);
 assert.equal(s.db.prepare('SELECT count(*) n FROM operations').get().n,0);s.close();
});
test('batch survives reopen; editing preserves date-only display',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'memo-batch-')),file=path.join(dir,'db.sqlite');
 try{
  let s=new MemoStore(file),ctx=s.context('private:1','1','1',true);
  const parsed=parseMemo('补记 '+entries.join('\n'));const r=s.write(ctx,'msg','batchSave',parsed);s.close();
  s=new MemoStore(file);ctx=s.context('private:1','1','1',true);
  assert.equal(s.read(ctx,'get',{id:r.items[0].id}).item.recordedAt,'2026-01-05');
  const edited=s.write(ctx,'edit','update',{id:r.items[0].id,content:'修正正文'});assert.equal(edited.recordedAt,'2026-01-05');
  assert.equal(s.read(ctx,'export',{}).items[0].recordPrecision,'date');assert.equal(s.write(ctx,'msg','batchSave',parsed).replayed,true);s.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
