import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { suggestedEligibility } from '../shared/eligibility.js';
import {annualCreditPolicy,annualLeaveKey,businessDate,earnedForYear,completedMonths,accrualMonths,isSpecialPrivilege,isWellness} from '../shared/accrual.js';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function openDatabase(path = resolve('data/leave.sqlite')) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
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
    CREATE TABLE IF NOT EXISTS manual_leave_usage (
      id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id),
      leave_type_id INTEGER NOT NULL REFERENCES leave_types(id), usage_date TEXT NOT NULL,
      days REAL NOT NULL CHECK(days > 0), reference TEXT NOT NULL, note TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      submitted_by INTEGER NOT NULL REFERENCES users(id), reviewed_by INTEGER REFERENCES users(id),
      review_note TEXT NOT NULL DEFAULT '', reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS manual_usage_reference
      ON manual_leave_usage(employee_id,leave_type_id,reference) WHERE status IN ('pending','approved');
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
  // Add columns in place; historical rows, IDs, credits and accounts are retained.
  transaction(db, () => {
    const usageColumns=db.prepare('PRAGMA table_info(manual_leave_usage)').all();
    if(!usageColumns.some(c=>c.name==='deleted_at')) {
      db.exec("ALTER TABLE manual_leave_usage ADD COLUMN deleted_at TEXT");
      db.exec("DROP INDEX IF EXISTS manual_usage_reference");
      db.exec("CREATE UNIQUE INDEX manual_usage_reference ON manual_leave_usage(employee_id,leave_type_id,reference) WHERE status IN ('pending','approved') AND deleted_at IS NULL");
    }
    if(!usageColumns.some(c=>c.name==='revision')) db.exec("ALTER TABLE manual_leave_usage ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    const employeeColumns = db.prepare('PRAGMA table_info(employees)').all();
    if (!employeeColumns.some(column => column.name === 'gender')) {
      db.exec("ALTER TABLE employees ADD COLUMN gender TEXT NOT NULL DEFAULT 'not_specified' CHECK(gender IN ('not_specified','female','male','other'))");
    }
    const typeColumns = db.prepare('PRAGMA table_info(leave_types)').all();
    if (!typeColumns.some(column => column.name === 'gender_eligibility')) {
      db.exec("ALTER TABLE leave_types ADD COLUMN gender_eligibility TEXT NOT NULL DEFAULT 'all' CHECK(gender_eligibility IN ('all','female','male'))");
      const update = db.prepare('UPDATE leave_types SET gender_eligibility=? WHERE id=?');
      for (const type of db.prepare('SELECT id,name,code FROM leave_types').all()) {
        update.run(suggestedEligibility(type.name,type.code),type.id);
      }
    }
  });
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    db.prepare('INSERT INTO users(username,name,password_hash,role) VALUES(?,?,?,?)').run(
      'admin', 'System administrator', hashPassword(process.env.ADMIN_PASSWORD || 'ChangeMe!2026'), 'admin'
    );
    const insert = db.prepare('INSERT INTO leave_types(name,code,description,requires_balance) VALUES(?,?,?,?)');
    insert.run('Vacation leave','VL','Planned personal time away from work.',1);
    insert.run('Sick leave','SL','Time away for health and recovery.',1);
    insert.run('Special privilege leave','SPL','Agency-approved special privileges.',1);
    insert.run('Other authorized leave','OAL','Other leave authorized by your agency.',0);
  }
  // Add the requested type once without altering existing leave types or records.
  db.prepare(`INSERT INTO leave_types(name,code,description,requires_balance)
    SELECT 'Wellness leave','WEL','Up to 3 consecutive calendar days per application.',0
    WHERE NOT EXISTS (SELECT 1 FROM leave_types WHERE code='WEL' OR lower(trim(name))='wellness leave')`).run();
  return db;
}
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch(error) { db.exec('ROLLBACK'); throw error; }
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value;
}
export function workingDays(start, end, holidays = [], halfDay = false) {
  if (!validDate(start) || !validDate(end) || start > end || start.slice(0,4) !== end.slice(0,4)) throw new Error('Choose valid dates in the same calendar year.');
  if (halfDay && start !== end) throw new Error('Half-day leave must start and end on the same date.');
  const excluded = new Set(holidays);
  let days = 0;
  for(let d = new Date(start + 'T00:00:00Z'); d <= new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+1)) {
    if(d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !excluded.has(d.toISOString().slice(0,10))) days++;
  }
  return halfDay ? days / 2 : days;
}
export function credit(db, employee, type, year, asOf=businessDate()) {
  const leaveType=db.prepare('SELECT * FROM leave_types WHERE id=?').get(type);
  const employeeRecord=db.prepare('SELECT * FROM employees WHERE id=?').get(employee);
  if(leaveType?.requires_balance && annualLeaveKey(leaveType) && employeeRecord) {
    const overrides=db.prepare('SELECT year,entitlement FROM balances WHERE employee_id=? AND leave_type_id=?').all(employee,type);
    const usages=db.prepare(`SELECT CAST(substr(start_date,1,4) AS INTEGER) year,
      SUM(CASE WHEN status='approved' THEN days ELSE 0 END) used,
      SUM(CASE WHEN status='pending' THEN days ELSE 0 END) pending
      FROM (
        SELECT start_date,days,status FROM leaves WHERE employee_id=? AND leave_type_id=?
        UNION ALL SELECT usage_date,days,status FROM manual_leave_usage
          WHERE employee_id=? AND leave_type_id=? AND status='approved' AND deleted_at IS NULL
      ) WHERE status IN ('approved','pending') GROUP BY year`).all(employee,type,employee,type);
    const firstYear=Math.min(Number(employeeRecord.appointment_date.slice(0,4)),year,...overrides.map(row=>row.year),...usages.map(row=>row.year));
    let carry=0;
    for(let current=firstYear;current<year;current++) {
      const override=overrides.find(row=>row.year===current);
      const eligible=completedMonths(employeeRecord.appointment_date,asOf < current+'-12-31'?asOf:current+'-12-31')>annualCreditPolicy.waitingMonths;
      const earned=override && eligible ? override.entitlement : earnedForYear(employeeRecord.appointment_date,current,asOf);
      const usage=usages.find(row=>row.year===current);
      carry=annualCreditPolicy.carryForward ? carry+earned-(usage?.used || 0)-(usage?.pending || 0) : 0;
    }
    const override=overrides.find(row=>row.year===year);
    const earned=earnedForYear(employeeRecord.appointment_date,year,asOf);
    const eligible=completedMonths(employeeRecord.appointment_date,asOf < year+'-12-31'?asOf:year+'-12-31')>annualCreditPolicy.waitingMonths;
    const annual=override && eligible ? override.entitlement : earned;
    const entitlement=carry+annual;
    const usage=usages.find(row=>row.year===year);
    const used=usage?.used || 0,pending=usage?.pending || 0;
    // Future requests reserve carried credits too, preventing reuse across years.
    const future=annualCreditPolicy.carryForward && year>=Number(asOf.slice(0,4))
      ? usages.filter(row=>row.year>year).reduce((sum,row)=>sum+row.used+row.pending,0) : 0;
    return {entitlement,used,pending,available:entitlement-used-pending-future,
      automatic:true,annual_entitlement:annual,earned_this_year:earned,carry_forward:carry,
      reserved_future:future,manual_override:!!override,as_of:asOf < year+'-12-31'?asOf:year+'-12-31',
      monthly_rate:annualCreditPolicy.daysPerMonth,
      service_months:completedMonths(employeeRecord.appointment_date,asOf < year+'-12-31'?asOf:year+'-12-31'),
      waiting_months:annualCreditPolicy.waitingMonths,
      earned_since_appointment:accrualMonths(employeeRecord.appointment_date,asOf < year+'-12-31'?asOf:year+'-12-31')*annualCreditPolicy.daysPerMonth};
  }
  const fixed=isSpecialPrivilege(leaveType)||isWellness(leaveType),annualDays=isWellness(leaveType)?5:3;
  const entitlement = fixed ? (employeeRecord && employeeRecord.appointment_date <= year+'-12-31' ? annualDays : 0) : db.prepare('SELECT entitlement FROM balances WHERE employee_id=? AND leave_type_id=? AND year=?').get(employee,type,year)?.entitlement || 0;
  const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='approved' THEN days ELSE 0 END),0) used,
    COALESCE(SUM(CASE WHEN status='pending' THEN days ELSE 0 END),0) pending FROM (
      SELECT start_date,days,status FROM leaves WHERE employee_id=? AND leave_type_id=?
      UNION ALL SELECT usage_date,days,status FROM manual_leave_usage
        WHERE employee_id=? AND leave_type_id=? AND status='approved' AND deleted_at IS NULL
    ) WHERE substr(start_date,1,4)=?`).get(employee,type,employee,type,String(year));
  return {entitlement, used: totals.used, pending: totals.pending, available: entitlement - totals.used - totals.pending,...(fixed?{fixed_annual:true,annual_entitlement:entitlement,carry_forward:0}: {})};
}

export function totalUsed(db,employee,type,year) {
  return db.prepare(`SELECT COALESCE(SUM(days),0) total FROM (
    SELECT days,start_date date FROM leaves WHERE employee_id=? AND leave_type_id=? AND status='approved'
    UNION ALL SELECT days,usage_date FROM manual_leave_usage WHERE employee_id=? AND leave_type_id=? AND status='approved' AND deleted_at IS NULL
  ) WHERE substr(date,1,4)<=?`).get(employee,type,employee,type,String(year)).total;
}

