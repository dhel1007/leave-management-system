import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {openDatabase,credit,hashPassword} from '../server/db.js';
import {createApp} from '../server/app.js';
import {earnedForYear,accrualMonths} from '../shared/accrual.js';

test('six-month wait uses appointment anniversaries without backdated accrual',()=>{
  assert.equal(accrualMonths('2026-01-15','2026-07-14'),0);
  assert.equal(earnedForYear('2026-01-15',2026,'2026-07-15'),0);
  assert.equal(earnedForYear('2026-01-15',2026,'2026-08-14'),0);
  assert.equal(earnedForYear('2026-01-15',2026,'2026-08-15'),1.25);
  assert.equal(earnedForYear('2025-10-31',2026,'2026-04-30'),0);
  assert.equal(earnedForYear('2025-10-31',2026,'2026-05-31'),1.25);
  assert.equal(earnedForYear('2024-02-29',2024,'2024-09-29'),1.25);
  assert.equal(earnedForYear('2025-07-01',2026,'2026-02-01'),1.25);
});

test('special privilege resets annually and wellness enforces consecutive calendar-day limit',async(t)=>{
  const db=openDatabase(':memory:');
  db.prepare('UPDATE users SET password_hash=?,must_change_password=0').run(hashPassword('Administrator!2026'));
  const employee=Number(db.prepare("INSERT INTO employees(employee_no,first_name,last_name,department,position,appointment_date,gender) VALUES('POLICY','Ana','Santos','Office','Officer','2025-01-01','female')").run().lastInsertRowid);
  const types=db.prepare('SELECT * FROM leave_types').all(),spl=types.find(t=>t.code==='SPL').id,wellness=types.find(t=>t.code==='WEL').id;
  db.prepare('INSERT INTO balances VALUES(?,?,2025,99)').run(employee,spl);
  db.prepare('INSERT INTO balances VALUES(?,?,2026,50)').run(employee,spl);
  db.prepare("INSERT INTO leaves(employee_id,leave_type_id,start_date,end_date,days,reason,status,submitted_by) VALUES(?,?,'2025-10-01','2025-10-02',2,'Historical usage','approved',1)").run(employee,spl);
  assert.equal(credit(db,employee,spl,2025,'2026-10-06').available,1);
  assert.equal(credit(db,employee,spl,2026,'2026-10-06').available,3);
  assert.equal(credit(db,employee,spl,2027,'2026-10-06').available,3);
  assert.equal(db.prepare('SELECT entitlement FROM balances WHERE year=2026').get().entitlement,50);
  db.prepare("INSERT INTO manual_leave_usage(employee_id,leave_type_id,usage_date,days,reference,note,status,submitted_by) VALUES(?,?,'2026-10-01',1,'SPL-CARD','Verified','approved',1)").run(employee,spl);
  assert.equal(credit(db,employee,spl,2026,'2026-10-06').available,2);
  db.prepare('UPDATE employees SET appointment_date=? WHERE id=?').run('2026-07-01',employee);
  db.prepare('INSERT INTO balances VALUES(?,1,2026,15)').run(employee);
  assert.equal(credit(db,employee,1,2026,'2026-10-06').entitlement,0);
  assert.equal(credit(db,employee,1,2027,'2027-01-01').entitlement,0);
  assert.equal(db.prepare('SELECT entitlement FROM balances WHERE leave_type_id=1').get().entitlement,15);
  db.prepare('UPDATE employees SET appointment_date=? WHERE id=?').run('2025-01-01',employee);
  const server=createApp(db,{serveFrontend:false,getToday:()=> '2026-10-06'}).listen(0,'127.0.0.1');
  await once(server,'listening');t.after(async()=>{await new Promise(r=>server.close(r));db.close();});
  const base='http://127.0.0.1:'+server.address().port+'/api';
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'Administrator!2026'})});
  const {csrf}=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
  async function call(path,body,method='POST') {
    const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  }
  assert.equal((await call('/balances',{employee_id:employee,leave_type_id:spl,year:2026,entitlement:10,note:'Override'},'PUT')).status,400);
  const request={employee_id:employee,leave_type_id:wellness,start_date:'2026-10-09',end_date:'2026-10-12',reason:'Wellness break'};
  assert.equal((await call('/leaves',request)).status,400); // 4 calendar days but only 2 working days
  const accepted=await call('/leaves',{...request,end_date:'2026-10-11'});
  assert.equal(accepted.status,201);
  assert.equal(accepted.body.days,1);
  assert.equal(credit(db,employee,wellness,2026,'2026-10-06').available,4);
  assert.equal((await call('/leaves',{...request,start_date:'2026-11-16',end_date:'2026-11-18'})).status,201);
  assert.equal((await call('/leaves',{...request,start_date:'2026-11-23',end_date:'2026-11-24'})).status,400);
  assert.equal((await call('/leaves',{...request,start_date:'2026-11-23',end_date:'2026-11-23'})).status,201);
  assert.equal(credit(db,employee,wellness,2026,'2026-10-06').available,0);
  assert.equal(credit(db,employee,wellness,2027,'2026-10-06').available,5);
  assert.equal((await call('/balances',{employee_id:employee,leave_type_id:wellness,year:2026,entitlement:99,note:'Override'},'PUT')).status,400);
  assert.equal((await call('/leaves',{...request,leave_type_id:spl,start_date:'2026-11-02',end_date:'2026-11-04'})).status,400);
  assert.equal((await call('/leaves',{...request,leave_type_id:spl,start_date:'2026-11-02',end_date:'2026-11-03'})).status,201);
  assert.equal(credit(db,employee,spl,2026,'2026-10-06').available,0);
  assert.equal(credit(db,employee,spl,2027,'2026-10-06').available,3);
});

