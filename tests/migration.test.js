import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase,hashPassword} from '../server/db.js';

test('legacy database gains eligibility columns without losing or altering existing records',()=>{
  const directory=mkdtempSync(join(tmpdir(),'cenrosolana-migration-'));
  const path=join(directory,'legacy.sqlite');
  let db;
  try {
    db=new DatabaseSync(path);
    db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY, employee_no TEXT NOT NULL UNIQUE, first_name TEXT NOT NULL,
      last_name TEXT NOT NULL, department TEXT NOT NULL, position TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '', appointment_date TEXT NOT NULL,
      employment_type TEXT NOT NULL DEFAULT 'Permanent', active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','hr','user')),
      employee_id INTEGER UNIQUE REFERENCES employees(id), active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS leave_types (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '', requires_balance INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS balances (
      employee_id INTEGER NOT NULL REFERENCES employees(id), leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
      year INTEGER NOT NULL, entitlement REAL NOT NULL CHECK(entitlement >= 0),
      PRIMARY KEY(employee_id,leave_type_id,year)
    );
    CREATE TABLE IF NOT EXISTS holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leaves (
      id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id),
      leave_type_id INTEGER NOT NULL REFERENCES leave_types(id), start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      days REAL NOT NULL CHECK(days > 0), half_day INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
      submitted_by INTEGER NOT NULL REFERENCES users(id), reviewed_by INTEGER REFERENCES users(id),
      review_note TEXT NOT NULL DEFAULT '', reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
      details TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS leave_employee_dates ON leaves(employee_id,start_date,end_date);
    CREATE INDEX IF NOT EXISTS leave_status ON leaves(status);
  `);
    db.prepare('INSERT INTO users(id,username,name,password_hash,role,must_change_password) VALUES(?,?,?,?,?,0)').run(4,'legacy.admin','Existing administrator',hashPassword('PreservedPassword!2026'),'admin');
    db.prepare('INSERT INTO employees(id,employee_no,first_name,last_name,department,position,appointment_date) VALUES(?,?,?,?,?,?,?)').run(7,'KEEP-007','Existing','Employee','Existing office','Existing position','2020-01-01');
    db.prepare('INSERT INTO leave_types(id,name,code,requires_balance) VALUES(?,?,?,1)').run(8,'Maternity leave','ML');
    db.prepare('INSERT INTO leave_types(id,name,code,requires_balance) VALUES(?,?,?,1)').run(9,'Paternity leave','PL');
    db.prepare('INSERT INTO balances VALUES(?,?,?,?)').run(7,8,2026,120);
    db.prepare("INSERT INTO leaves(id,employee_id,leave_type_id,start_date,end_date,days,reason,status,submitted_by,reviewed_by,review_note) VALUES(17,7,8,'2026-01-05','2026-01-06',2,'Keep this leave','approved',4,4,'Keep this review')").run();
    db.prepare('INSERT INTO holidays VALUES(?,?)').run('2026-01-01','Existing holiday');
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('existing-session',4,'existing-csrf',Date.now()+100000);
    db.prepare('INSERT INTO audit(id,user_id,action,details) VALUES(32,4,?,?)').run('Existing activity','Keep this history');
    const tables=['employees','leave_types','balances','leaves','users','holidays','sessions','audit'];
    const originals=tables.map(name=>({name,columns:db.prepare('PRAGMA table_info('+name+')').all().map(c=>c.name).join(','),rows:db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()}));
    db.close();
    db=openDatabase(path);
    for(const table of originals) {
      const rows=db.prepare('SELECT '+table.columns+' FROM '+table.name+' ORDER BY rowid').all();
      assert.deepEqual(table.name==='leave_types'?rows.filter(r=>table.rows.some(o=>o.id===r.id)):rows,table.rows);
    }
    assert.equal(db.prepare("SELECT count(*) n FROM leave_types WHERE code='WEL'").get().n,1);
    assert.equal(db.prepare('SELECT gender FROM employees WHERE id=7').get().gender,'not_specified');
    assert.equal(db.prepare('SELECT gender_eligibility FROM leave_types WHERE id=8').get().gender_eligibility,'female');
    assert.equal(db.prepare('SELECT gender_eligibility FROM leave_types WHERE id=9').get().gender_eligibility,'male');
    db.prepare("UPDATE leave_types SET gender_eligibility='all' WHERE id=8").run();
    db.close();
    db=openDatabase(path);
    assert.equal(db.prepare('SELECT gender_eligibility FROM leave_types WHERE id=8').get().gender_eligibility,'all');
    assert.equal(db.prepare("SELECT count(*) n FROM leave_types WHERE code='WEL'").get().n,1);
    assert.equal(db.prepare('SELECT status FROM leaves WHERE id=17').get().status,'approved');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    db.close();db=null;
  } finally {if(db?.isOpen)db.close();rmSync(directory,{recursive:true,force:true});}
});
