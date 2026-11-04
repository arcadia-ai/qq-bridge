"""Consistent SQLite backup; never print memo content or credentials."""
import argparse
import datetime
import json
import os
from pathlib import Path
import sqlite3

os.umask(0o077)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
args = parser.parse_args()
base = args.root.resolve() / 'state' / 'memo'
source = base / 'memos.sqlite3'
if not source.exists():
    raise SystemExit('Memo database not initialized; backup skipped with failure')
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
root = base / 'backups'
root.mkdir(parents=True, exist_ok=True, mode=0o700)
daily = root / ('daily-' + now.strftime('%Y-%m-%d') + '.sqlite3')
paths = [daily]
if now.weekday() == 0:
    paths.append(root / ('weekly-' + now.strftime('%Y-%m-%d') + '.sqlite3'))
with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as src:
    for dest in paths:
        tmp = dest.with_suffix('.tmp')
        with sqlite3.connect(tmp) as out:
            src.backup(out)
            assert out.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        os.replace(tmp, dest)
        dest.chmod(0o600)
for pattern, keep in [('daily-*.sqlite3', 7), ('weekly-*.sqlite3', 4)]:
    for old in sorted(root.glob(pattern), reverse=True)[keep:]:
        assert old.resolve().parent == root.resolve()
        old.unlink()
# Full disaster-recovery export, not an unauthenticated QQ download endpoint.
dest = base / 'exports'
dest.mkdir(exist_ok=True, mode=0o700)
with sqlite3.connect(f'file:{daily}?mode=ro', uri=True) as db:
    db.row_factory = sqlite3.Row
    rows = [dict(r) for r in db.execute('SELECT * FROM memos WHERE deleted=0')]
tmp = dest / 'memos.json.tmp'
tmp.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
os.replace(tmp, dest / 'memos.json')
print('Memo consistent backup and protected JSON export completed.')
