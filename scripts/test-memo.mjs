import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { MemoStore,parseMemo,memoReply,formatMemoTime } from '../src/memo-store.mjs';

test('private, group sharing, isolation and author enforcement',()=>{
 const s=new MemoStore(':memory:');
 const a=s.context('group:123','10','1',true), b=s.context('group:123','20','1',true);
 const owner=s.context('group:123','1','1',true), other=s.context('group:456','10','1',true);
 const priv=s.context('private:1','1','1',true);
 assert.throws(()=>s.context('private:20','20','1',true));
 assert.throws(()=>s.context('group:123','10','1',false));
 const r=s.write(a,'1','save',{content:'我不吃香菜'});
 assert.equal(s.search(b,'香菜').items[0].id,r.item.id);
 assert.equal(s.read(b,'export',{page:1}).items[0].id,r.item.id);
 assert.equal(s.read(other,'export',{page:1}).items.length,0);
 assert.equal(s.search(other,'香菜').total,0); assert.equal(s.search(priv,'香菜').total,0);
 assert.throws(()=>s.row(other,r.item.id));
 assert.throws(()=>s.write(b,'2','update',{id:r.item.id,content:'篡改'}));
 assert.throws(()=>s.write(b,'3','delete',{id:r.item.id}));
 s.write(owner,'4','update',{id:r.item.id,content:'能吃葱，不吃香菜'});
 assert.equal(s.row(a,r.item.id).version,2);
 assert.throws(()=>s.write(a,'5','confirmDelete',{id:r.item.id}));
 s.write(a,'6','delete',{id:r.item.id});
 s.write(owner,'7','update',{id:r.item.id,content:'不吃葱'});
 assert.throws(()=>s.write(a,'8','confirmDelete',{id:r.item.id}));
 s.write(a,'9','delete',{id:r.item.id});s.write(a,'10','confirmDelete',{id:r.item.id});
 assert.equal(s.search(b,'').total,0);s.close();
});
test('commit survives reopen, idempotence and pending receipts',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'memo-test-')), file=path.join(dir,'db.sqlite');
 try {
  let s=new MemoStore(file);let ctx=s.context('private:1','1','1',true);
  const r=s.write(ctx,'source','save',{content:'升级先备份'});
  assert.equal(s.write(ctx,'source','save',{content:'重复'}).replayed,true);
  assert.equal(s.search(ctx,'').total,1);s.close();
  s=new MemoStore(file);ctx=s.context('private:1','1','1',true);
  assert.equal(s.row(ctx,r.item.id).content,'升级先备份');
  s.delivered(ctx,'source');assert.equal(s.write(ctx,'source','save',{content:'重复'}).delivered,true);
  assert.throws(()=>s.write(ctx,'','save',{content:'x'}));
  assert.throws(()=>s.write(ctx,'bad','save',{content:''}));
  assert.equal(s.search(ctx,'').total,1);s.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('explicit commands, no quote/informal auto-writes',()=>{
 assert.equal(parseMemo('帮我记住：我不吃香菜').content,'我不吃香菜');
 assert.equal(parseMemo('记一下准备读书分享，主题是数据库').content,'准备读书分享，主题是数据库');
 assert.equal(parseMemo('帮我记一下：周末打游戏').content,'周末打游戏');
 assert.equal(parseMemo('你帮我记住我不吃香菜').content,'我不吃香菜');
 assert.equal(parseMemo('记录一下 周五开会').content,'周五开会');
 assert.equal(parseMemo('记住了吗？'),null);
 assert.equal(parseMemo('记一下这个'),null);
 assert.equal(parseMemo('他说记一下读书'),null);
 assert.equal(parseMemo('备忘 修改 M-000001 新约定').action,'update');
 assert.equal(parseMemo('备忘 确认删除 M-000001').action,'confirmDelete');
 assert.equal(parseMemo('他说“帮我记住：xx”'),null);
 assert.equal(parseMemo('你是不是没记住？'),null);
 assert.equal(parseMemo('备忘 列表 2').page,2);
 assert.equal(parseMemo('备忘 导出 2').action,'export');
 assert.match(memoReply({ok:true,total:0,items:[]},'group:1'),/未查到/);
});
test('specified Beijing record time, strict dates, defaults and editing preservation',()=>{
 const s=new MemoStore(':memory:'),ctx=s.context('group:123','10','1',true);
 const cmd=parseMemo('记一下 2026-03-04 11:10 小组例会，准备文档 A 和 B');
 assert.equal(cmd.content,'小组例会，准备文档 A 和 B');
 assert.equal(formatMemoTime(cmd.recorded),'2026-03-04 11:10:00');
 const r=s.write(ctx,'custom','save',cmd),id=r.item.id;
 assert.equal(r.item.recordedAt,'2026-03-04 11:10:00');assert.equal(r.item.timeSource,'specified');
 assert.match(memoReply(r,ctx.scope),/实际入库/);
 assert.match(memoReply(s.read(ctx,'list',{}),ctx.scope),/2026-03-04 11:10:00/);
 const actualCreated=r.item.created;
 const edited=s.write(ctx,'edit','update',{id,content:'修改后的正文'});
 assert.equal(edited.recordedAt,'2026-03-04 11:10:00');
 assert.equal(s.read(ctx,'get',{id}).item.created,actualCreated);
 assert.equal(s.read(ctx,'export',{}).items[0].recordedAt,'2026-03-04 11:10:00');
 for(const input of ['2026-02-30 11:10 正文','2026-03-04 24:10 正文','2026-03-04 11:99 正文','2026-03-04','2026-03-04 11:10']){
  const bad=parseMemo('记一下 '+input);assert(bad.recordedAtError);assert.throws(()=>s.write(ctx,'bad-'+input,'save',bad),/指定日期/);
 }
 const leap=parseMemo('记一下 2028-02-29 00:00:12 闰年');assert.equal(formatMemoTime(leap.recorded),'2028-02-29 00:00:12');
 const ordinary=s.write(ctx,'ordinary','save',parseMemo('记一下不带时间'));
 assert.equal(ordinary.item.recordedAt,formatMemoTime(ordinary.item.created));assert.equal(ordinary.item.timeSource,'automatic');
 assert.equal(s.search(ctx,'').total,2);s.close();
});
test('additive migration preserves old rows; specified date survives reopen',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'memo-custom-migrate-')),file=path.join(dir,'memo.sqlite');
 try{
  const raw=new DatabaseSync(file);
  raw.exec(`CREATE TABLE memos(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,author TEXT NOT NULL,content TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL,updated INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
    INSERT INTO memos(scope,author,content,created,updated) VALUES('private:1','1','旧记录',1700000000000,1700000000000);`);raw.close();
  let s=new MemoStore(file),ctx=s.context('private:1','1','1',true);
  assert.equal(s.row(ctx,'M-000001').created,1700000000000);
  assert.equal(s.read(ctx,'get',{id:'M-000001'}).item.timeSource,'automatic');
  const r=s.write(ctx,'date','save',parseMemo('记一下 2026-03-04 11:10 正文'));s.close();
  s=new MemoStore(file);ctx=s.context('private:1','1','1',true);
  assert.equal(s.read(ctx,'get',{id:r.item.id}).item.recordedAt,'2026-03-04 11:10:00');
  assert.equal(s.write(ctx,'date','save',parseMemo('记一下 2026-03-04 11:10 正文')).replayed,true);s.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('creation and update times display in Beijing timezone without changing stored creation',()=>{
 assert.equal(formatMemoTime(Date.parse('2026-01-02T03:04:05Z')),'2026-01-02 11:04:05');
 assert.equal(formatMemoTime(Date.parse('2026-01-01T16:00:00Z')),'2026-01-02 00:00:00');
 assert.equal(formatMemoTime(undefined),'未记录');
 const s=new MemoStore(':memory:'),ctx=s.context('private:1','1','1',true);
 const r=s.write(ctx,'1','save',{content:'时间验收'}),id=r.item.id,created=r.item.created;
 assert.equal(r.item.timeZone,'Asia/Shanghai');
 assert.match(memoReply(r,ctx.scope),/记录时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（北京时间）/);
 assert.match(memoReply(s.read(ctx,'list',{}),ctx.scope),/记录时间/);
 assert.match(memoReply(s.read(ctx,'get',{id}),ctx.scope),/记录时间/);
 const update=s.write(ctx,'2','update',{id,content:'修改后的内容'});
 assert.match(memoReply(update,ctx.scope),/最后修改：/);
 assert.equal(s.row(ctx,id).created,created);
 assert.match(memoReply(s.read(ctx,'get',{id}),ctx.scope),/最后修改：/);
 assert.equal(s.read(ctx,'export',{}).items[0].recordedAt,formatMemoTime(created));
 s.close();
});
test('compact request actually commits, lists, reopens and stays idempotent',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'memo-compact-')),file=path.join(dir,'memo.sqlite');
 try{
  let s=new MemoStore(file);let ctx=s.context('private:1','1','1',true);
  const cmd=parseMemo('记一下准备读书分享，主题是数据库');
  const saved=s.write(ctx,'original-source',cmd.action,cmd);
  assert.match(memoReply(saved,ctx.scope),/已保存 M-/);
  assert.equal(s.read(ctx,'list',{}).items[0].content,cmd.content);s.close();
  s=new MemoStore(file);ctx=s.context('private:1','1','1',true);
  assert.equal(s.read(ctx,'search',{query:'读书'}).items[0].id,saved.item.id);
  assert.equal(s.write(ctx,'original-source',cmd.action,cmd).replayed,true);
  assert.equal(s.search(ctx,'').total,1);s.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
