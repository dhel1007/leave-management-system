import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {openDatabase,credit,hashPassword} from '../server/db.js';
import {createApp} from '../server/app.js';
import {businessDate,completedMonths,earnedForYear} from '../shared/accrual.js';

test('completed service months honor appointment days, short months, leap years and future dates',()=>{
  assert.equal(completedMonths('2026-01-15','2026-04-14'),2);
  assert.equal(completedMonths('2026-01-15','2026-04-15'),3);
  assert.equal(completedMonths('2026-01-31','2026-02-27'),0);
  assert.equal(completedMonths('2026-01-31','2026-02-28'),1);
  assert.equal(completedMonths('2026-01-31','2026-03-30'),1);
  assert.equal(completedMonths('2026-01-31','2026-03-31'),2);
  assert.equal(completedMonths('2024-02-29','2025-02-28'),12);
  assert.equal(completedMonths('2024-02-29','2025-02-27'),11);
  assert.equal(completedMonths('2027-01-01','2026-10-06'),0);
  assert.equal(earnedForYear('2026-07-15',2026,'2026-10-06'),0);
  assert.equal(earnedForYear('2020-01-01',2025,'2026-10-06'),15);
  assert.equal(earnedForYear('2026-01-01',2026,'2026-12-31'),6.25);
  assert.equal(earnedForYear('2025-01-01',2027,'2026-10-06'),0);
  assert.equal(businessDate(new Date('2026-10-05T16:00:00Z')),'2026-10-06');
});

function addEmployee(db,appointment='2025-01-01') {
  return Number(db.prepare('INSERT INTO employees(employee_no,first_name,last_name,department,position,appointment_date,gender) VALUES(?,?,?,?,?,?,?)').run('AUTO-001','Ana','Accrual','Administration','Officer',appointment,'female').lastInsertRowid);
}
function addLeave(db,employee,type,year,days,status,startMonth='06') {
  db.prepare('INSERT INTO leaves(employee_id,leave_type_id,start_date,end_date,days,reason,status,submitted_by) VALUES(?,?,?,?,?,?,?,1)').run(employee,type,year+'-'+startMonth+'-02',year+'-'+startMonth+'-03',days,'Calculation fixture',status);
}
test('automatic sick/vacation credits accrue, carry forward, advance monthly and do not create duplicate grants',()=>{
  const db=openDatabase(':memory:');
  try {
    const employee=addEmployee(db);
    for(const type of [1,2]) {
      let result=credit(db,employee,type,2026,'2026-10-06');
      assert.equal(result.entitlement,18.75);
      assert.equal(result.carry_forward,6.25);
      assert.equal(result.earned_this_year,12.5);
      assert.equal(result.earned_since_appointment,18.75);
      assert.equal(result.available,18.75);
      assert.equal(credit(db,employee,type,2026,'2026-11-01').available,20);
      assert.deepEqual(credit(db,employee,type,2026,'2026-10-06'),result);
      assert.equal(credit(db,employee,type,2025,'2026-10-06').entitlement,6.25);
      assert.equal(credit(db,employee,type,2027,'2026-10-06').available,18.75);
    }
    assert.equal(db.prepare('SELECT COUNT(*) total FROM balances').get().total,0);
    db.prepare('UPDATE employees SET appointment_date=? WHERE id=?').run('2025-01-15',employee);
    assert.equal(credit(db,employee,1,2026,'2026-10-06').available,17.5);
    db.prepare('UPDATE employees SET appointment_date=? WHERE id=?').run('2027-01-15',employee);
    assert.equal(credit(db,employee,1,2026,'2026-10-06').available,0);
    assert.equal(credit(db,employee,2,2026,'2026-10-06').available,0);
    assert.equal(credit(db,employee,3,2026,'2026-10-06').entitlement,0);
  } finally {db.close();}
});
test('saved annual overrides remain intact while used, pending and future reservations reduce available credits',()=>{
  const db=openDatabase(':memory:');
  try {
    const employee=addEmployee(db);
    db.prepare('INSERT INTO balances VALUES(?,?,?,?)').run(employee,1,2025,10);
    db.prepare('INSERT INTO balances VALUES(?,?,?,?)').run(employee,1,2026,5);
    addLeave(db,employee,1,2025,2,'approved');
    addLeave(db,employee,1,2025,1,'pending','07');
    addLeave(db,employee,1,2026,2,'approved');
    addLeave(db,employee,1,2026,1,'pending','07');
    addLeave(db,employee,1,2027,3,'pending');
    const result=credit(db,employee,1,2026,'2026-10-06');
    assert.equal(result.carry_forward,7);
    assert.equal(result.annual_entitlement,5);
    assert.equal(result.entitlement,12);
    assert.equal(result.used,2);
    assert.equal(result.pending,1);
    assert.equal(result.reserved_future,3);
    assert.equal(result.available,6);
    assert.equal(result.manual_override,true);
    assert.equal(credit(db,employee,1,2027,'2026-10-06').available,6);
    assert.equal(credit(db,employee,1,2028,'2026-10-06').available,6);
    assert.equal(credit(db,employee,1,2025,'2026-10-06').available,7);
    assert.deepEqual(db.prepare('SELECT year,entitlement FROM balances ORDER BY year').all().map(r=>({...r})),[{year:2025,entitlement:10},{year:2026,entitlement:5}]);
    db.prepare("UPDATE leaves SET status='cancelled' WHERE start_date LIKE '2027-%'").run();
    assert.equal(credit(db,employee,1,2026,'2026-10-06').available,9);
    assert.equal(credit(db,employee,2,2026,'2026-10-06').available,18.75);
  } finally {db.close();}
});
test('employee and credit APIs show appointment-based totals, reserve future leave and accept quarter-day annual overrides',async(t)=>{
  const db=openDatabase(':memory:');
  const employee=addEmployee(db);
  db.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=1').run(hashPassword('Administrator!2026'));
  let date='2026-10-06';
  const server=createApp(db,{serveFrontend:false,getToday:()=>date}).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'Administrator!2026'})});
  assert.equal(login.status,200);
  const {csrf}=await login.json();
  const cookie=login.headers.get('set-cookie').split(';')[0];
  async function call(path,method='GET',body) {
    const response=await fetch(base+'/api'+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json()};
  }
  let employees=(await call('/employees?year=2026')).data;
  assert.equal(employees[0].leave_credits.vacation.available,18.75);
  assert.equal(employees[0].leave_credits.sick.available,18.75);
  const application={employee_id:employee,leave_type_id:1,start_date:'2026-11-02',end_date:'2026-11-03',reason:'Book earned credits'};
  assert.equal((await call('/leaves','POST',application)).status,201);
  assert.equal((await call('/leaves','POST',{...application,start_date:'2027-01-04',end_date:'2027-01-15'})).status,201);
  employees=(await call('/employees?year=2026')).data;
  assert.equal(employees[0].leave_credits.vacation.available,6.75);
  assert.equal(employees[0].leave_credits.vacation.reserved_future,10);
  assert.equal(employees[0].leave_credits.sick.available,18.75);
  assert.equal((await call('/leaves','POST',{...application,start_date:'2028-01-03',end_date:'2028-01-14'})).status,400);
  const balances=(await call('/balances?year=2026')).data;
  assert.equal(balances.find(b=>b.leave_type_id===1).available,employees[0].leave_credits.vacation.available);
  assert.equal((await call('/balances','PUT',{employee_id:employee,leave_type_id:1,year:2026,entitlement:12.75,note:'Annual correction'})).status,200);
  assert.equal(db.prepare('SELECT entitlement FROM balances WHERE employee_id=? AND leave_type_id=1 AND year=2026').get(employee).entitlement,12.75);
  assert.equal((await call('/balances','PUT',{employee_id:employee,leave_type_id:1,year:2026,entitlement:2,note:'Too little funding'})).status,400);
  date='2026-11-01';
  employees=(await call('/employees?year=2026')).data;
  assert.equal(employees[0].leave_credits.sick.available,20);
  assert.equal(employees[0].leave_credits.vacation.manual_override,true);
  assert.equal(employees[0].leave_credits.vacation.annual_entitlement,12.75);
});
