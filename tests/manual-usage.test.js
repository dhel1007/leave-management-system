import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {openDatabase,hashPassword,credit,totalUsed} from '../server/db.js';
import {createApp} from '../server/app.js';

test('manual usage requires HR submission and admin approval, preserves carry and prevents duplicates',async(t)=>{
  const db=openDatabase(':memory:');
  db.prepare('UPDATE users SET password_hash=?,must_change_password=0').run(hashPassword('Administrator!2026'));
  const hrId=Number(db.prepare("INSERT INTO users(username,name,password_hash,role,must_change_password) VALUES('hr','HR',?,'hr',0)").run(hashPassword('HROfficerNew!2026')).lastInsertRowid);
  const employee=Number(db.prepare("INSERT INTO employees(employee_no,first_name,last_name,department,position,appointment_date,gender) VALUES('TEST','Ana','Santos','Office','Officer','2025-01-01','female')").run().lastInsertRowid);
  db.prepare("INSERT INTO users(username,name,password_hash,role,employee_id,must_change_password) VALUES('worker','Ana',?,'user',?,0)").run(hashPassword('EmployeeNew!2026'),employee);
  const vl=db.prepare("SELECT id FROM leave_types WHERE code='VL'").get().id;
  const pl=Number(db.prepare("INSERT INTO leave_types(name,code,gender_eligibility) VALUES('Paternity leave','PL','male')").run().lastInsertRowid);
  const server=createApp(db,{serveFrontend:false,getToday:()=> '2026-10-06'}).listen(0,'127.0.0.1');
  await once(server,'listening');t.after(async()=>{await new Promise(r=>server.close(r));db.close();});
  const base='http://127.0.0.1:'+server.address().port+'/api';
  async function call(path,method,body,session) {
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json(),response};
  }
  async function login(username,password) {
    const r=await call('/auth/login','POST',{username,password});
    assert.equal(r.status,200);return {cookie:r.response.headers.get('set-cookie').split(';')[0],csrf:r.body.csrf};
  }
  const admin=await login('admin','Administrator!2026'),hr=await login('hr','HROfficerNew!2026'),worker=await login('worker','EmployeeNew!2026');
  const entry={employee_id:employee,leave_type_id:vl,usage_date:'2025-12-15',days:2.25,reference:'CARD-001',note:'Verified historical usage'};
  assert.equal((await call('/manual-usage','POST',entry,admin)).status,403);
  assert.equal((await call('/manual-usage','POST',entry,worker)).status,403);
  assert.equal((await call('/manual-usage','GET',undefined,worker)).status,403);
  assert.equal((await call('/manual-usage','POST',{...entry,leave_type_id:pl},hr)).status,400);
  assert.equal((await call('/manual-usage','POST',{...entry,usage_date:'2026-10-07'},hr)).status,400);
  const before=credit(db,employee,vl,2026,'2026-10-06');
  const submitted=await call('/manual-usage','POST',entry,hr);assert.equal(submitted.status,201);
  const usage=submitted.body.id;
  assert.deepEqual(credit(db,employee,vl,2026,'2026-10-06'),before);
  assert.equal(totalUsed(db,employee,vl,2026),0);
  assert.equal((await call('/manual-usage','POST',entry,hr)).status,409);
  assert.equal((await call('/manual-usage/'+usage+'/status','PATCH',{status:'approved'},hr)).status,403);
  assert.equal((await call('/manual-usage/'+usage+'/status','PATCH',{status:'approved',note:'Verified'},admin)).status,200);
  const after=credit(db,employee,vl,2026,'2026-10-06');
  assert.equal(after.carry_forward,before.carry_forward-2.25);
  assert.equal(after.available,before.available-2.25);
  assert.equal(after.used,0);
  assert.equal(totalUsed(db,employee,vl,2026),2.25);
  assert.equal(totalUsed(db,employee,vl,2024),0);
  assert.equal((await call('/manual-usage/'+usage+'/status','PATCH',{status:'approved'},admin)).status,409);
  const excessive=await call('/manual-usage','POST',{...entry,reference:'CARD-002',days:100},hr);
  assert.equal(excessive.status,201);
  assert.equal((await call('/manual-usage/'+excessive.body.id+'/status','PATCH',{status:'approved'},admin)).status,400);
  assert.equal(db.prepare('SELECT status FROM manual_leave_usage WHERE id=?').get(excessive.body.id).status,'pending');
  assert.equal((await call('/manual-usage/'+excessive.body.id+'/status','PATCH',{status:'rejected',note:'Incorrect days'},admin)).status,200);
  assert.equal(totalUsed(db,employee,vl,2026),2.25);
  db.prepare("INSERT INTO leaves(employee_id,leave_type_id,start_date,end_date,days,reason,status,submitted_by) VALUES(?,?,'2026-10-05','2026-10-05',1,'Application','approved',?)").run(employee,vl,hrId);
  assert.equal((await call('/manual-usage','POST',{...entry,usage_date:'2026-10-05',reference:'DUPLICATE'},hr)).status,400);
  assert.equal(totalUsed(db,employee,vl,2026),3.25);
  const balances=await call('/balances?year=2026','GET',undefined,worker);
  assert.equal(balances.body.find(r=>r.leave_type_id===vl).total_used,3.25);
  assert.equal(db.prepare('SELECT count(*) n FROM manual_leave_usage').get().n,2);
  assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action LIKE '%manual leave usage%'").get().n,4);
  let row=db.prepare('SELECT * FROM manual_leave_usage WHERE id=?').get(usage);
  const edit={...entry,days:3.25,revision:row.revision,change_note:'Correct leave card total'};
  assert.equal((await call('/manual-usage/'+usage,'PUT',edit,hr)).status,403);
  assert.equal((await call('/manual-usage/'+usage,'DELETE',{revision:row.revision,change_note:'Remove'},hr)).status,403);
  assert.equal((await call('/manual-usage/'+usage,'PUT',{...edit,days:100},admin)).status,400);
  assert.equal((await call('/manual-usage/'+usage,'PUT',edit,admin)).status,200);
  assert.equal(totalUsed(db,employee,vl,2026),4.25);
  assert.equal(credit(db,employee,vl,2026,'2026-10-06').carry_forward,before.carry_forward-3.25);
  assert.equal((await call('/manual-usage/'+usage,'PUT',edit,admin)).status,409);
  row=db.prepare('SELECT * FROM manual_leave_usage WHERE id=?').get(usage);
  const wellness=db.prepare("SELECT id FROM leave_types WHERE code='WEL'").get().id;
  assert.equal((await call('/manual-usage/'+usage,'PUT',{...edit,revision:row.revision,leave_type_id:wellness,days:6},admin)).status,400);
  assert.equal(db.prepare('SELECT leave_type_id FROM manual_leave_usage WHERE id=?').get(usage).leave_type_id,vl);
  assert.equal((await call('/manual-usage/'+usage,'DELETE',{revision:edit.revision,change_note:'Duplicate'},admin)).status,409);
  assert.equal((await call('/manual-usage/'+usage,'DELETE',{revision:row.revision,change_note:'Duplicate source record'},admin)).status,200);
  assert.equal(totalUsed(db,employee,vl,2026),1);
  assert.equal(credit(db,employee,vl,2026,'2026-10-06').carry_forward,before.carry_forward);
  assert.ok(db.prepare('SELECT deleted_at FROM manual_leave_usage WHERE id=?').get(usage).deleted_at);
  assert.equal((await call('/manual-usage','GET',undefined,admin)).body.some(r=>r.id===usage),false);
  assert.equal((await call('/manual-usage/'+usage+'/status','PATCH',{status:'approved'},admin)).status,404);
  assert.equal((await call('/manual-usage','POST',entry,hr)).status,201);
  assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action='Edited manual leave usage'").get().n,1);
  assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action='Deleted manual leave usage'").get().n,1);

  const wellnessEntry={...entry,leave_type_id:wellness,usage_date:'2026-10-01',reference:'WEL-001',days:5};
  assert.equal((await call('/manual-usage','POST',{...wellnessEntry,days:5.25},hr)).status,400);
  const wellnessSubmitted=await call('/manual-usage','POST',wellnessEntry,hr);
  assert.equal(wellnessSubmitted.status,201);
  assert.equal((await call('/manual-usage','POST',{...wellnessEntry,reference:'WEL-002',days:1},hr)).status,400);
  const wellnessRow=db.prepare('SELECT * FROM manual_leave_usage WHERE id=?').get(wellnessSubmitted.body.id);
  assert.equal((await call('/manual-usage/'+wellnessRow.id,'PUT',{...wellnessEntry,days:6,revision:wellnessRow.revision,change_note:'Too much'},admin)).status,400);
  assert.equal(db.prepare('SELECT days FROM manual_leave_usage WHERE id=?').get(wellnessRow.id).days,5);
  assert.equal((await call('/manual-usage/'+wellnessRow.id+'/status','PATCH',{status:'approved'},admin)).status,200);
  assert.equal(credit(db,employee,wellness,2026,'2026-10-06').available,0);

});


