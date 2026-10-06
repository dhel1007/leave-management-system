import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/db.js';

const path=resolve(process.env.DB_PATH || 'data/leave.sqlite');
if(!existsSync(path)) throw new Error('Existing database not found. This command never creates or replaces a database.');
const destination=resolve('data/backups/pre-gender-'+new Date().toISOString().replaceAll(':','-')+'.sqlite');
mkdirSync(dirname(destination),{recursive:true});
const original=new DatabaseSync(path,{readOnly:true});
const tables=original.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t=>t.name);
const snapshot=tables.map(name=>({
  name,
  columns:original.prepare('PRAGMA table_info("'+name+'")').all().map(c=>'"'+c.name.replaceAll('"','""')+'"').join(','),
  rows:original.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()
}));
await backup(original,destination);
original.close();
const db=openDatabase(path);
try {
  for(const table of snapshot) {
    const current=db.prepare('SELECT '+table.columns+' FROM "'+table.name+'" ORDER BY rowid').all();
    const retained=table.name==='leave_types'?current.filter(row=>table.rows.some(original=>original.id===row.id)):current;
    assert.deepEqual(retained,table.rows,'Existing '+table.name+' data changed unexpectedly.');
    if(table.name==='leave_types') assert.ok(current.filter(row=>!table.rows.some(original=>original.id===row.id)).every(row=>row.code==='WEL' && row.name==='Wellness leave'),'Unexpected new leave type.');
  }
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  console.log('Migration complete. All existing columns and records were preserved.');
  console.log(JSON.stringify(Object.fromEntries(snapshot.map(t=>[t.name,t.rows.length]))));
  console.log('Backup: '+destination);
} finally {db.close();}
