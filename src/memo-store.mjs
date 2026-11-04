import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Explicit zone: the server's OS timezone must not change the QQ display.
export function formatMemoTime(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '未记录';
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return '未记录';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'
  }).formatToParts(date).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function entryText(item) {
  const created = item.recordedAt || formatMemoTime(item.created ?? (item.version === 1 ? item.updated : undefined));
  const updated = item.modifiedAt || formatMemoTime(item.updated);
  return `${item.id}：${item.content}\n记录时间：${created}（北京时间）`
    + (item.timeSource === 'specified' ? `\n实际入库：${item.storedAt || formatMemoTime(item.created)}（北京时间；记录时间为指定时间）` : '')
    + (item.version > 1 ? `\n最后修改：${updated}（北京时间）` : '');
}

export class MemoStore {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS memos(id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY, memo INTEGER, actor TEXT, content TEXT, version INTEGER, time INTEGER);
      CREATE TABLE IF NOT EXISTS operations(scope TEXT, actor TEXT, source TEXT, result TEXT, delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,actor,source));
      CREATE TABLE IF NOT EXISTS pending(scope TEXT, actor TEXT, memo INTEGER, version INTEGER, expires INTEGER, PRIMARY KEY(scope,actor,memo));
      CREATE INDEX IF NOT EXISTS memo_scope ON memos(scope,deleted,updated);`);
    // Additive migration: existing records retain their original creation dates.
    if (!this.db.prepare('PRAGMA table_info(memos)').all().some(c=>c.name==='recorded')) {
      this.db.exec('ALTER TABLE memos ADD COLUMN recorded INTEGER');
    }
    if (!this.db.prepare('PRAGMA table_info(memos)').all().some(c=>c.name==='record_precision')) {
      this.db.exec("ALTER TABLE memos ADD COLUMN record_precision TEXT NOT NULL DEFAULT 'second'");
    }
    if (file !== ':memory:') fs.chmodSync(file, 0o600);
  }
  close() { this.db.close(); }
  delivered(ctx, source) { this.db.prepare('UPDATE operations SET delivered=1 WHERE scope=? AND actor=? AND source=?').run(ctx.scope,ctx.actor,String(source)); }
  id(n) { return `M-${String(n).padStart(6, '0')}`; }
  context(key, actor, owner, allowed) {
    if (!allowed || !/^(private|group):[1-9]\d*$/.test(key) || !/^[1-9]\d*$/.test(actor)) throw Error('该会话不可用');
    if (key.startsWith('private:') && (actor !== String(owner) || key !== `private:${owner}`)) throw Error('仅主人私聊可使用个人备忘');
    return { scope: key, actor, owner: String(owner) };
  }
  row(ctx, id) {
    const match = /^M-(\d+)$/i.exec(String(id));
    const r = match && this.db.prepare('SELECT * FROM memos WHERE id=? AND scope=? AND deleted=0').get(Number(match[1]), ctx.scope);
    if (!r) throw Error('未找到可访问的备忘');
    return r;
  }
  view(r) { return { id: this.id(r.id), content: r.content, author: r.author, version: r.version,
    created:r.created, updated:r.updated, recorded:r.recorded ?? r.created,
    recordedAt:r.record_precision === 'date' ? formatMemoTime(r.recorded ?? r.created).slice(0,10) : formatMemoTime(r.recorded ?? r.created),
    recordPrecision:r.record_precision || 'second', storedAt:formatMemoTime(r.created),
    timeSource:r.recorded == null ? 'automatic':'specified', modifiedAt:formatMemoTime(r.updated), timeZone:'Asia/Shanghai' }; }
  search(ctx, query = '', page = 1) {
    const q = String(query).trim().toLowerCase().slice(0, 300);
    const rows = this.db.prepare('SELECT * FROM memos WHERE scope=? AND deleted=0 ORDER BY updated DESC,id DESC').all(ctx.scope);
    const words = q.split(/[\s，。？！、,;；]+/u).filter(Boolean);
    const scored = rows.map(r => {
      const s = r.content.toLowerCase();
      let score = !q ? 1 : s.includes(q) ? 100 : 0;
      for (const w of words) {
        if (s.includes(w)) score += 20;
        else if (w.length > 2) for (let i = 0; i < w.length - 1; i++) if (s.includes(w.slice(i, i + 2))) score++;
      }
      return { r, score };
    }).filter(x => x.score > 0).sort((a,b) => b.score-a.score || b.r.updated-a.r.updated);
    const offset = (Math.max(1, Math.min(1000, Number(page) || 1)) - 1) * 10;
    return { ok: true, total: scored.length, items: scored.slice(offset, offset+10).map(x => this.view(x.r)) };
  }
  read(ctx, action, args) {
    if (action === 'export') {
      const page = Math.max(1,Math.min(10000,Number(args.page)||1));
      const all = this.db.prepare('SELECT * FROM memos WHERE scope=? AND deleted=0 ORDER BY id').all(ctx.scope);
      return {ok:true,export:true,page,pages:all.length,items:all.slice(page-1,page).map(r=>this.view(r))};
    }
    if (action === 'get') return { ok: true, item: this.view(this.row(ctx, args.id)) };
    if (action === 'search' || action === 'list') return this.search(ctx, action === 'search' ? args.query : '', args.page);
    throw Error('不支持的查询操作');
  }
  write(ctx, source, action, args) {
    if (!String(source || '').trim()) throw Error('缺少原始消息ID，未写入');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT result,delivered FROM operations WHERE scope=? AND actor=? AND source=?').get(ctx.scope, ctx.actor, String(source));
      if (old) { this.db.exec('COMMIT'); return { ...JSON.parse(old.result), replayed: true, delivered: !!old.delivered }; }
      const now = Date.now();
      let result;
      if (action === 'batchSave') {
        if (args.batchError) throw Error(args.batchError);
        if (!Array.isArray(args.items) || !args.items.length || args.items.length > 50) throw Error('备忘批量补记须为1至50条');
        if (args.items.reduce((n,x)=>n+String(x.content||'').length,0)>50000) throw Error('备忘整批正文超过50000字');
        const items=args.items.map(item=>this.insert(ctx,item,now));
        result={ok:true,committed:true,batch:true,items};
      } else if (action === 'save') {
        result = { ok:true,committed:true,item:this.insert(ctx,args,now) };
      } else {
        const r = this.row(ctx,args.id);
        if (ctx.actor !== r.author && ctx.actor !== ctx.owner) throw Error('仅创建者本人或主人可修改、删除此条备忘');
        if (action === 'delete') {
          this.db.prepare('INSERT OR REPLACE INTO pending VALUES(?,?,?,?,?)').run(ctx.scope,ctx.actor,r.id,r.version,now+300000);
          result = { ok: true, needsConfirm: true, id: this.id(r.id), text: `请在5分钟内发送：备忘 确认删除 ${this.id(r.id)}` };
        } else {
          if (action === 'confirmDelete') {
            const p = this.db.prepare('SELECT * FROM pending WHERE scope=? AND actor=? AND memo=?').get(ctx.scope,ctx.actor,r.id);
            if (!p || p.expires < now || p.version !== r.version) throw Error('删除确认已失效或条目已变化，请重新发起删除');
          } else if (action !== 'update') throw Error('不支持的写入操作');
          const content = String(args.content || '').trim();
          if (action === 'update' && (!content || content.length > 10000)) throw Error('备忘正文须为1至10000字');
          this.db.prepare('INSERT INTO revisions(memo,actor,content,version,time) VALUES(?,?,?,?,?)').run(r.id,ctx.actor,r.content,r.version,now);
          this.db.prepare('UPDATE memos SET content=?,deleted=?,version=version+1,updated=? WHERE id=?').run(action==='update'?content:r.content, action==='confirmDelete'?1:0,now,r.id);
          this.db.prepare('DELETE FROM pending WHERE scope=? AND memo=?').run(ctx.scope,r.id);
          result = { ok: true, committed: true, id: this.id(r.id), deleted: action==='confirmDelete', version: r.version+1,
            created:r.created, updated:now, recordedAt:this.view(r).recordedAt, modifiedAt:formatMemoTime(now) };
        }
      }
      this.db.prepare('INSERT INTO operations(scope,actor,source,result) VALUES(?,?,?,?)').run(ctx.scope,ctx.actor,String(source),JSON.stringify(result));
      this.db.exec('COMMIT');
      return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  // Called only inside the transaction owned by write(), including whole batches.
  insert(ctx,args,now) {
        if (args.recordedAtError) throw Error(args.recordedAtError);
        if (args.recorded !== undefined && (!Number.isSafeInteger(args.recorded) || args.recorded < 0)) throw Error('备忘指定日期无效，未保存');
        const content = String(args.content || '').trim();
        if (!content || content.length > 10000) throw Error('备忘正文须为1至10000字');
        const count = this.db.prepare('SELECT count(*) AS n FROM memos WHERE scope=? AND deleted=0').get(ctx.scope).n;
        if (count >= 5000) throw Error('本会话备忘已达5000条，请先整理');
        const precision=args.recordPrecision === 'date' ? 'date':'second';
        const id = Number(this.db.prepare('INSERT INTO memos(scope,author,content,created,updated,recorded,record_precision) VALUES(?,?,?,?,?,?,?)').run(ctx.scope,ctx.actor,content,now,now,args.recorded ?? null,precision).lastInsertRowid);
        return this.view(this.row(ctx,this.id(id)));
  }
}

export function parseBatchMemo(input) {
  const body=String(input).replace(/^(?:请)?(?:(?:帮|替|给)我)?补记(?:一下)?[：:\s-]*/, '');
  const fail=message=>({action:'batchSave',items:[],batchError:`备忘批量未保存：${message}`});
  const pattern=/(?:(?:(\d{4})年)?(\d{1,2})月(\d{1,2})(?:日|号)|(\d{4})-(\d{1,2})-(\d{1,2}))(?:[ T]*(\d{1,2})[：:](\d{2})(?!\d)(?::(\d{2})(?!\d))?)?/g;
  const dates=[...body.matchAll(pattern)];
  if (!dates.length) return fail('未识别日期，请给每条写上日期，例如“11月2日：正文”。');
  if (dates.length>50) return fail('一次最多50条。');
  // A preamble is allowed, but do not silently drop a dated-looking/numbered business record.
  const preamble=body.slice(0,dates[0].index).replace(/[\s:：,，。;；\-•*·]/g,'');
  if (preamble && !/^(?:前面几条|前面这几条|以下几条|下面几条|这些|前面的|以下|下面|几条|共\d+条|[1-9][.)、])$/.test(preamble)) return fail('首条日期前有未能归属的内容，请明确每条的日期。');
  const items=[];
  for(let i=0;i<dates.length;i++){
    const m=dates[i];
    const year=Number(m[1]||m[4]||2026),month=Number(m[2]||m[5]),day=Number(m[3]||m[6]);
    const hasTime=m[7]!==undefined;
    const stamp=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')} ${hasTime?`${m[7]}:${m[8]}:${m[9]||'00'}`:'00:00:00'}`;
    let content=body.slice(m.index+m[0].length,dates[i+1]?.index ?? body.length).trim();
    content=content.replace(/^[：:\s]+/,'').replace(/\r?\n[ \t]*(?:[-•*·]|\d+[.)、])[ \t]*$/,'').replace(/\s+[-•*·]\s*$/,'').replace(/[;；]\s*$/,'').trim();
    if (!content || /(?:止盈|止损|入场)[：:\s]*$/.test(content) || /^\d{1,2}[：:]\d/.test(content)) return fail(`第${i+1}条正文或时间不完整，请补齐。`);
    const parsed=saveRequest(`${stamp} ${content}`);
    if (parsed.recordedAtError) return fail(`第${i+1}条日期或时间不合法。`);
    items.push({...parsed,recordPrecision:hasTime?'second':'date'});
  }
  return {action:'batchSave',items};
}

function saveRequest(content) {
  content = String(content).trim();
  if (!/^\d{4}-\d{1,2}-\d{1,2}(?:[ T]|$)/.test(content)) return { action:'save',content };
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+([\s\S]+)$/.exec(content);
  const bad = {action:'save',content,recordedAtError:'备忘指定日期或正文无效，未保存。请用：记一下 YYYY-MM-DD HH:mm 正文（北京时间）'};
  if (!m) return bad;
  const [year,month,day,hour,minute,second]=m.slice(1,7).map(x=>Number(x||0));
  if (year<1970 || year>9999 || month<1 || month>12 || day<1 || day>31 || hour>23 || minute>59 || second>59) return bad;
  const local = new Date(Date.UTC(year,month-1,day,hour,minute,second));
  // Date.UTC normalizes impossible dates, so validate all components explicitly.
  if (local.getUTCFullYear()!==year || local.getUTCMonth()!==month-1 || local.getUTCDate()!==day) return bad;
  const recorded=local.getTime()-8*60*60*1000;
  if (recorded<0 || !m[7].trim()) return bad;
  return {action:'save',content:m[7].trim(),recorded};
}

// Only explicit commands write. Conversation text, quotes and model guesses are not write requests.
export function parseMemo(input) {
  const s = String(input).trim();
  if (/^(?:请)?(?:(?:帮|替|给)我)?补记/.test(s)) return parseBatchMemo(s);
  let m = /^(?:备忘(?:录)?[：:\s]+(?:记下|保存|新增)[：:\s]+|(?:请)?(?:帮我)?(?:记住|记下|记个备忘)[：:\s]+)([\s\S]+)$/.exec(s);
  if (m) return saveRequest(m[1]);
  // Colloquial explicit requests also allow no delimiter: “记一下2216…”.
  // Remain anchored so quoted dialogue / a statement about someone else cannot write.
  m = /^(?:你)?(?:请)?(?:(?:帮|替|给)我)?(?:记录一下|记一下|记下|记住|记个备忘)[：:\s，,]*([\s\S]+)$/.exec(s);
  if (m) {
    const content = m[1].trim();
    if (!/^(?:了吗|了么|吗|没有|没|什么|啥|这件事|这个|刚才那个|刚才那条|刚刚说的|上面那条)[。？！?!]?$/.test(content)) {
      return saveRequest(content);
    }
  }
  m = /^备忘(?:录)?\s+(修改|更新)\s+(M-\d+)\s+([\s\S]+)$/i.exec(s);
  if (m) return { action: 'update', id:m[2], content:m[3] };
  m = /^备忘(?:录)?\s+(确认删除|删除|忘掉|查看)\s+(M-\d+)\s*$/i.exec(s);
  if (m) return { action: ({确认删除:'confirmDelete',删除:'delete',忘掉:'delete',查看:'get'})[m[1]], id:m[2] };
  m = /^备忘(?:录)?\s+(搜索|查找)\s+(.+)$/.exec(s);
  if (m) return { action:'search',query:m[2] };
  m = /^备忘(?:录)?\s+列表(?:\s+(\d+))?$/.exec(s);
  if (m) return { action:'list',page:Number(m[1])||1 };
  m = /^备忘(?:录)?\s+导出(?:\s+(\d+))?$/.exec(s);
  if (m) return { action:'export',page:Number(m[1])||1 };
  if (/^备忘(?:录)?(?:\s+帮助)?$/.test(s)) return { action:'help' };
  return null;
}

export function memoReply(r, scope) {
  const range = scope.startsWith('group:') ? '本群共享' : '主人私密';
  if (r.batch) return `已补记 ${r.items.length} 条，范围：${range}；长期保留。\n\n`+r.items.map(entryText).join('\n\n');
  if (r.export) return `备忘文本导出 ${r.page}/${r.pages}（每页一条；继续请发送“备忘 导出 页码”）：\n`+JSON.stringify(r.items,null,2);
  if (r.needsConfirm) return r.text;
  if (r.deleted) return `已删除 ${r.id}，不再参与查询和召回。历史修订及备份按保留策略处理。`;
  if (r.committed) return r.item ? `已保存 ${entryText(r.item)}\n范围：${range}；长期保留。`
    : `已更新 ${r.id}（版本${r.version}）。\n记录时间：${r.recordedAt || formatMemoTime(r.created)}（北京时间）\n最后修改：${r.modifiedAt || formatMemoTime(r.updated)}（北京时间）`;
  if (r.item) return entryText(r.item);
  return r.items.length ? `共${r.total}条，本页${r.items.length}条：\n`+r.items.map(entryText).join('\n\n') : '未查到相关备忘。';
}
