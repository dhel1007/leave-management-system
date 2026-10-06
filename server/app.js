import express from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { hashPassword, verifyPassword, transaction, credit, workingDays, validDate, totalUsed } from './db.js';
import { genderOptions, eligibilityOptions, suggestedEligibility, eligibilityReason } from '../shared/eligibility.js';
import {annualLeaveKey,businessDate,isSpecialPrivilege,isWellness,wellnessError,completedMonths,annualCreditPolicy} from '../shared/accrual.js';

const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const str = (value, label, max = 200, optional = false) => {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.trim().length > max) fail(label + ' is required and must be at most ' + max + ' characters.');
  return value.trim();
};
const id = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) fail('Invalid record ID.'); return n; };
const yearValue = value => { const n = Number(value); if(!Number.isInteger(n) || n < 2000 || n > 2100) fail('Year must be between 2000 and 2100.'); return n; };
const passwordValue = value => { if(typeof value !== 'string' || value.length < 12 || value.length > 128) fail('Password must contain 12–128 characters.'); return value; };
const digest = token => createHash('sha256').update(token).digest('hex');
const publicUser = user => ({id:user.id,username:user.username,name:user.name,role:user.role,employee_id:user.employee_id,must_change_password:!!user.must_change_password});

export function createApp(db, {serveFrontend = true, getToday = businessDate} = {}) {
  const app = express();
  const getCredit=(employee,type,year)=>credit(db,employee,type,year,getToday());
  app.disable('x-powered-by');
  app.use((req,res,next) => {
    res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"});
    if(req.path.startsWith('/api')) res.set('Cache-Control','no-store');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)) {
      if(req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) return res.status(403).json({error:'Requests must come from this local application.'});
      if(!req.is('application/json')) return res.status(415).json({error:'JSON requests are required.'});
    }
    next();
  });
  app.use(express.json({limit:'64kb'}));
  const audit = (user, action, details) => db.prepare('INSERT INTO audit(user_id,action,details) VALUES(?,?,?)').run(user.id,action,details);
  const attempts = new Map();
  app.post('/api/auth/login',(req,res) => {
    const username = str(req.body.username,'Username',80);
    const password = typeof req.body.password === 'string' && req.body.password.length <= 128 ? req.body.password : '';
    const key = req.ip + ':' + username.toLowerCase();
    const now = Date.now();
    if(attempts.size > 1000) for(const [k,v] of attempts) if(v.until < now) attempts.delete(k);
    const attempt = attempts.get(key);
    if(attempt?.until > now && attempt.count >= 8) fail('Too many attempts. Try again in 15 minutes.',429);
    const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
    if(!user || !verifyPassword(password,user.password_hash)) {
      attempts.set(key,{count:(attempt?.until > now ? attempt.count : 0)+1,until:now+15*60*1000});
      fail('Incorrect username or password.',401);
    }
    attempts.delete(key);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),user.id,csrf,now+8*60*60*1000);
    res.cookie('agency_session',token,{httpOnly:true,sameSite:'strict',maxAge:8*60*60*1000,path:'/'});
    audit(user,'Signed in',user.username);
    res.json({user:publicUser(user),csrf});
  });
  app.use('/api',(req,res,next) => {
    const token = (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('agency_session='))?.slice(15);
    if(!token) return res.status(401).json({error:'Please sign in.'});
    const session = db.prepare('SELECT s.csrf,s.token_hash,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').get(digest(token),Date.now());
    if(!session) return res.status(401).json({error:'Session expired. Please sign in.'});
    req.user = session;
    if(!['GET','HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== session.csrf) return res.status(403).json({error:'Invalid security token. Refresh and try again.'});
    if(session.must_change_password && !['/auth/me','/auth/password','/auth/logout'].includes(req.path)) return res.status(403).json({error:'Change your temporary password before continuing.'});
    next();
  });
  const staff = (req,res,next) => { if(!['admin','hr'].includes(req.user.role)) return res.status(403).json({error:'HR or administrator access required.'}); next(); };
  const admin = (req,res,next) => { if(req.user.role !== 'admin') return res.status(403).json({error:'Administrator access required.'}); next(); };
  app.get('/api/auth/me',(req,res)=>res.json({user:publicUser(req.user),csrf:req.user.csrf}));
  app.post('/api/auth/logout',(req,res)=>{db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.user.token_hash); res.clearCookie('agency_session',{path:'/'}); res.json({ok:true});});
  app.post('/api/auth/password',(req,res)=>{
    if(!verifyPassword(String(req.body.currentPassword || ''),req.user.password_hash)) fail('Current password is incorrect.');
    const password = passwordValue(req.body.newPassword);
    if(verifyPassword(password,req.user.password_hash)) fail('Choose a different password.');
    transaction(db,()=>{
      db.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?').run(hashPassword(password),req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(req.user.id,req.user.token_hash);
      audit(req.user,'Changed password',req.user.username);
    });
    res.json({ok:true});
  });
  app.get('/api/employees',(req,res)=>{
    const year=yearValue(req.query.year || Number(getToday().slice(0,4)));
    const employees=req.user.role === 'user' ? db.prepare('SELECT * FROM employees WHERE id=?').all(req.user.employee_id || -1) : db.prepare('SELECT * FROM employees ORDER BY last_name,first_name').all();
    const annualTypes=db.prepare('SELECT * FROM leave_types WHERE requires_balance=1').all().filter(t=>annualLeaveKey(t));
    res.json(employees.map(employee=>({
      ...employee,
      credit_year:year,
      credit_as_of:getToday() < year+'-12-31'?getToday():year+'-12-31',
      leave_credits:Object.fromEntries(['vacation','sick'].map(key=>{
        const type=annualTypes.find(t=>annualLeaveKey(t)===key);
        return [key,type && !eligibilityReason(employee,type) ? getCredit(employee.id,type.id,year) : null];
      }))
    })));
  });
  function employeeInput(body, existing = {}) {
    const date = str(body.appointment_date,'Appointment date',10);
    if(!validDate(date)) fail('Invalid appointment date.');
    const employment = str(body.employment_type,'Employment type');
    if(!['Permanent','Temporary','Contractual','Casual','Co-terminous'].includes(employment)) fail('Invalid employment type.');
    const email = str(body.email || '', 'Email',200,true);
    if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Invalid email address.');
    const gender = body.gender ?? existing.gender ?? 'not_specified';
    if(!genderOptions.some(option=>option.value===gender)) fail('Choose a valid gender.');
    return [str(body.employee_no,'Employee number',40),str(body.first_name,'First name',80),str(body.last_name,'Last name',80),
      str(body.department,'Department',100),str(body.position,'Position',100),email,date,employment,body.active === false || body.active === 0 ? 0 : 1,gender];
  }
  app.post('/api/employees',staff,(req,res)=>{
    const values = employeeInput(req.body);
    const result = transaction(db,()=>{const r=db.prepare('INSERT INTO employees(employee_no,first_name,last_name,department,position,email,appointment_date,employment_type,active,gender) VALUES(?,?,?,?,?,?,?,?,?,?)').run(...values);audit(req.user,'Added employee',values[0]);return r;});
    res.status(201).json({id:Number(result.lastInsertRowid)});
  });
  app.put('/api/employees/:id',staff,(req,res)=>{
    const employee = id(req.params.id);
    const existing = db.prepare('SELECT * FROM employees WHERE id=?').get(employee);
    if(!existing) fail('Employee not found.',404);
    const values = employeeInput(req.body,existing);
    transaction(db,()=>{db.prepare('UPDATE employees SET employee_no=?,first_name=?,last_name=?,department=?,position=?,email=?,appointment_date=?,employment_type=?,active=?,gender=? WHERE id=?').run(...values,employee);audit(req.user,'Updated employee',values[0]);});
    res.json({ok:true});
  });
  app.get('/api/leave-types',(req,res)=>res.json(db.prepare('SELECT * FROM leave_types ORDER BY id').all().map(t=>(isSpecialPrivilege(t)||isWellness(t))?{...t,requires_balance:1}:t)));
  function typeInput(body, existing = {}) {
    const code = str(body.code,'Code',12).toUpperCase();
    if(!/^[A-Z0-9-]+$/.test(code)) fail('Code must use letters, numbers or hyphens.');
    const eligibility=body.gender_eligibility ?? existing.gender_eligibility ?? suggestedEligibility(body.name,code);
    if(!eligibilityOptions.some(option=>option.value===eligibility)) fail('Choose a valid gender eligibility rule.');
    return [str(body.name,'Leave type name',80),code,str(body.description || '','Description',400,true),body.requires_balance ? 1 : 0,body.active === false || body.active === 0 ? 0 : 1,eligibility];
  }
  app.post('/api/leave-types',staff,(req,res)=>{
    const values=typeInput(req.body);
    const result=transaction(db,()=>{const r=db.prepare('INSERT INTO leave_types(name,code,description,requires_balance,active,gender_eligibility) VALUES(?,?,?,?,?,?)').run(...values);audit(req.user,'Added leave type',values[0]);return r;});
    res.status(201).json({id:Number(result.lastInsertRowid)});
  });
  app.put('/api/leave-types/:id',staff,(req,res)=>{
    const type = id(req.params.id);
    const existing=db.prepare('SELECT * FROM leave_types WHERE id=?').get(type);
    if(!existing) fail('Leave type not found.',404);
    const values=typeInput(req.body,existing);
    if(existing.requires_balance !== values[3] && (db.prepare('SELECT id FROM leaves WHERE leave_type_id=? LIMIT 1').get(type) || db.prepare('SELECT id FROM manual_leave_usage WHERE leave_type_id=? LIMIT 1').get(type))) fail('Balance tracking cannot change after a type has been used. Create a new type instead.');
    transaction(db,()=>{db.prepare('UPDATE leave_types SET name=?,code=?,description=?,requires_balance=?,active=?,gender_eligibility=? WHERE id=?').run(...values,type);audit(req.user,'Updated leave type',values[0]);});
    res.json({ok:true});
  });
  app.get('/api/balances',(req,res)=>{
    const year=yearValue(req.query.year || Number(getToday().slice(0,4)));
    const employees = req.user.role === 'user' ? db.prepare('SELECT id,first_name,last_name,employee_no,gender FROM employees WHERE id=?').all(req.user.employee_id || -1) : db.prepare('SELECT id,first_name,last_name,employee_no,gender FROM employees').all();
    const types=db.prepare('SELECT * FROM leave_types').all().filter(t=>t.requires_balance || (isSpecialPrivilege(t)||isWellness(t)));
    res.json(employees.flatMap(e=>types.filter(t=>!eligibilityReason(e,t)).map(t=>({employee_id:e.id,employee_name:e.first_name+' '+e.last_name,employee_no:e.employee_no,leave_type_id:t.id,leave_type:t.name,code:t.code,year,total_used:totalUsed(db,e.id,t.id,year),...getCredit(e.id,t.id,year)}))));
  });
  app.put('/api/balances',staff,(req,res)=>{
    const employee=id(req.body.employee_id),type=id(req.body.leave_type_id),year=yearValue(req.body.year),amount=Number(req.body.entitlement);
    if(!Number.isFinite(amount) || amount < 0 || amount > 1000) fail('Entitlement must be 0–1,000 days.');
    const employeeRecord=db.prepare('SELECT * FROM employees WHERE id=?').get(employee);
    const leaveType=db.prepare('SELECT * FROM leave_types WHERE id=?').get(type);
    if(!employeeRecord || !leaveType || !(leaveType.requires_balance || isSpecialPrivilege(leaveType)||isWellness(leaveType))) fail('Employee or tracked leave type not found.',404);
    const increment=annualLeaveKey(leaveType)?4:2;
    if(amount*increment !== Math.round(amount*increment)) fail('Use quarter-day increments for sick/vacation credits and half-day increments for other leave.');
    if(isSpecialPrivilege(leaveType)||isWellness(leaveType)) fail('This leave type has a fixed annual allowance and cannot be adjusted.');
    if(annualLeaveKey(leaveType) && completedMonths(employeeRecord.appointment_date,getToday() < year+'-12-31'?getToday():year+'-12-31')<=annualCreditPolicy.waitingMonths) fail('Sick and vacation credits are available only after six months of service.');
    const ineligible=eligibilityReason(employeeRecord,leaveType);
    if(ineligible) fail('Cannot assign leave credits. '+ineligible);
    const note=str(req.body.note,'Adjustment explanation',500);
    transaction(db,()=>{
      const balance=getCredit(employee,type,year);
      if(amount + (balance.carry_forward || 0) < balance.used + balance.pending + (balance.reserved_future || 0)) fail('Entitlement and carry-forward cannot be less than approved and pending leave.');
      db.prepare('INSERT INTO balances VALUES(?,?,?,?) ON CONFLICT(employee_id,leave_type_id,year) DO UPDATE SET entitlement=excluded.entitlement').run(employee,type,year,amount);
      audit(req.user,'Adjusted leave credits',JSON.stringify({employee,type,year,before:balance.annual_entitlement ?? balance.entitlement,after:amount,note}));
    });
    res.json({ok:true});
  });

  app.get('/api/manual-usage',staff,(req,res)=>{
    res.json(db.prepare(`SELECT m.*,e.first_name,e.last_name,e.employee_no,t.name leave_type,t.code,
      u.name submitter_name,r.name reviewer_name FROM manual_leave_usage m
      JOIN employees e ON e.id=m.employee_id JOIN leave_types t ON t.id=m.leave_type_id
      JOIN users u ON u.id=m.submitted_by LEFT JOIN users r ON r.id=m.reviewed_by
      WHERE m.deleted_at IS NULL ORDER BY m.id DESC`).all());
  });
  function checkManualEligibility(row) {
    const e=db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(row.employee_id);
    const t=db.prepare('SELECT * FROM leave_types WHERE id=? AND active=1').get(row.leave_type_id);
    if(!e || !t) fail('Choose an active employee and leave type.');
    const reason=eligibilityReason(e,t);
    if(reason) fail(reason);
    if(row.usage_date<e.appointment_date) fail('Usage date cannot precede the appointment date.');
    if(db.prepare("SELECT id FROM leaves WHERE employee_id=? AND leave_type_id=? AND status IN ('pending','approved') AND start_date<=? AND end_date>=?").get(e.id,t.id,row.usage_date,row.usage_date))
      fail('An application already covers this usage date and leave type. Use that application to avoid counting it twice.');
    return t;
  }

  function checkUsageCredits(row,type) {
    if(!(type.requires_balance || isSpecialPrivilege(type)||isWellness(type))) return;
    const usageYear=Number(row.usage_date.slice(0,4)),currentYear=Number(getToday().slice(0,4));
    const lastYear=annualLeaveKey(type)?Math.max(currentYear,usageYear,...db.prepare("SELECT CAST(substr(start_date,1,4) AS INTEGER) year FROM leaves WHERE employee_id=? AND leave_type_id=? AND status IN ('pending','approved')").all(row.employee_id,row.leave_type_id).map(r=>r.year)):usageYear;
    for(let year=usageYear;year<=lastYear;year++) if(getCredit(row.employee_id,row.leave_type_id,year).available<0) fail('Insufficient credits for this usage or subsequent carried balances.');
  }

  function checkManualWellness(row,excludeId=0,status='pending') {
    const type=db.prepare('SELECT * FROM leave_types WHERE id=?').get(row.leave_type_id);
    if(!isWellness(type)) return;
    if(row.days>5) fail('Manual wellness usage cannot exceed 5 days.');
    if(status==='rejected') return;
    const year=row.usage_date.slice(0,4);
    const applicationDays=db.prepare("SELECT COALESCE(SUM(days),0) days FROM leaves WHERE employee_id=? AND leave_type_id=? AND substr(start_date,1,4)=? AND status IN ('approved','pending')").get(row.employee_id,row.leave_type_id,year).days;
    const manualDays=db.prepare("SELECT COALESCE(SUM(days),0) days FROM manual_leave_usage WHERE employee_id=? AND leave_type_id=? AND substr(usage_date,1,4)=? AND status IN ('approved','pending') AND deleted_at IS NULL AND id<>?").get(row.employee_id,row.leave_type_id,year,excludeId).days;
    if(applicationDays+manualDays+row.days>5) fail('Wellness leave is limited to 5 days per year, including existing approved and pending entries.');
  }

  function manualEditInput(body) {
    const row={employee_id:id(body.employee_id),leave_type_id:id(body.leave_type_id),usage_date:body.usage_date,days:Number(body.days),reference:str(body.reference,'Source record reference',100),note:str(body.note,'Usage explanation',1000)};
    if(!validDate(row.usage_date)||row.usage_date>getToday()||Number(row.usage_date.slice(0,4))<2000) fail('Choose a usage date from 2000 through today.');
    if(!Number.isFinite(row.days)||row.days<=0||row.days>1000||row.days*4!==Math.round(row.days*4)) fail('Used credits must be 0.25–1,000 days in quarter-day increments.');
    return row;
  }
  function currentUsage(req) {
    const row=db.prepare('SELECT * FROM manual_leave_usage WHERE id=? AND deleted_at IS NULL').get(id(req.params.id));
    if(!row) fail('Usage entry not found.',404);
    if(Number(req.body.revision)!==row.revision || req.body.revision===undefined) fail('This entry changed. Refresh before editing or deleting.',409);
    return row;
  }
  app.put('/api/manual-usage/:id',admin,(req,res)=>{
    const values=manualEditInput(req.body),reason=str(req.body.change_note,'Reason for edit',1000);
    transaction(db,()=>{
      const before=currentUsage(req);
      const type=checkManualEligibility(values);
      checkManualWellness(values,before.id,before.status);
      if(before.status==='approved' && (before.employee_id===req.user.employee_id || values.employee_id===req.user.employee_id)) fail('A different administrator must edit your approved usage.',403);
      db.prepare('UPDATE manual_leave_usage SET employee_id=?,leave_type_id=?,usage_date=?,days=?,reference=?,note=?,revision=revision+1 WHERE id=?').run(values.employee_id,values.leave_type_id,values.usage_date,values.days,values.reference,values.note,before.id);
      if(before.status==='approved') checkUsageCredits(values,type);
      audit(req.user,'Edited manual leave usage',JSON.stringify({before,after:values,reason}));
    });
    res.json({ok:true});
  });
  app.delete('/api/manual-usage/:id',admin,(req,res)=>{
    const reason=str(req.body.change_note,'Reason for deletion',1000);
    transaction(db,()=>{
      const before=currentUsage(req);
      db.prepare("UPDATE manual_leave_usage SET deleted_at=datetime('now'),revision=revision+1 WHERE id=?").run(before.id);
      audit(req.user,'Deleted manual leave usage',JSON.stringify({before,reason}));
    });
    res.json({ok:true});
  });

  app.post('/api/manual-usage',staff,(req,res)=>{
    if(req.user.role!=='hr') fail('Only HR can submit manual usage. Administrators review submissions.',403);
    const employee=id(req.body.employee_id),type=id(req.body.leave_type_id),date=req.body.usage_date,days=Number(req.body.days);
    if(!validDate(date) || date>getToday() || Number(date.slice(0,4))<2000) fail('Choose a usage date from 2000 through today.');
    if(!Number.isFinite(days) || days<=0 || days>1000 || days*4!==Math.round(days*4)) fail('Used credits must be 0.25–1,000 days in quarter-day increments.');
    const reference=str(req.body.reference,'Source record reference',100),note=str(req.body.note,'Usage explanation',1000);
    const result=transaction(db,()=>{
      checkManualEligibility({employee_id:employee,leave_type_id:type,usage_date:date});
      checkManualWellness({employee_id:employee,leave_type_id:type,usage_date:date,days});
      const r=db.prepare('INSERT INTO manual_leave_usage(employee_id,leave_type_id,usage_date,days,reference,note,submitted_by) VALUES(?,?,?,?,?,?,?)').run(employee,type,date,days,reference,note,req.user.id);
      audit(req.user,'Submitted manual leave usage','Usage '+r.lastInsertRowid+' · '+reference+' · '+days+' days');
      return r;
    });
    res.status(201).json({id:Number(result.lastInsertRowid),status:'pending'});
  });
  app.patch('/api/manual-usage/:id/status',admin,(req,res)=>{
    const usage=id(req.params.id),status=req.body.status;
    if(!['approved','rejected'].includes(status)) fail('Choose approve or reject.');
    const note=str(req.body.note || '','Review note',1000,status!=='rejected');
    transaction(db,()=>{
      const row=db.prepare('SELECT * FROM manual_leave_usage WHERE id=? AND deleted_at IS NULL').get(usage);
      if(!row) fail('Usage entry not found.',404);
      if(row.status!=='pending') fail('This entry has already been reviewed.',409);
      if(req.body.revision!==undefined && Number(req.body.revision)!==row.revision) fail('This entry changed. Refresh before reviewing.',409);
      let type;
      if(status==='approved') {
        if(row.employee_id===req.user.employee_id) fail('A different administrator must approve your usage.',403);
        type=checkManualEligibility(row);
        checkManualWellness(row,row.id,'approved');
      }
      db.prepare("UPDATE manual_leave_usage SET revision=revision+1,status=?,review_note=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=?").run(status,note,req.user.id,usage);
      if(type) checkUsageCredits(row,type);
      audit(req.user,'Manual leave usage '+status,'Usage '+usage+' · '+row.reference+(note?' · '+note:''));
    });
    res.json({ok:true});
  });

  app.get('/api/holidays',(req,res)=>res.json(db.prepare('SELECT * FROM holidays ORDER BY date').all()));
  app.post('/api/holidays',staff,(req,res)=>{
    const date=req.body.date;
    if(!validDate(date)) fail('Invalid holiday date.');
    const name=str(req.body.name,'Holiday name',100);
    transaction(db,()=>{db.prepare('INSERT INTO holidays(date,name) VALUES(?,?)').run(date,name);audit(req.user,'Added non-working day',date+' '+name);});
    res.status(201).json({ok:true});
  });
  app.delete('/api/holidays/:date',staff,(req,res)=>{
    const date=req.params.date;
    transaction(db,()=>{db.prepare('DELETE FROM holidays WHERE date=?').run(date);audit(req.user,'Removed non-working day',date);});
    res.json({ok:true});
  });
  app.get('/api/leaves',(req,res)=>{
    const own=req.user.role === 'user';
    res.json(db.prepare(`SELECT l.*,e.first_name,e.last_name,e.employee_no,e.department,t.name leave_type,t.code,
      COALESCE(u.name,CASE WHEN l.status='rejected' AND l.reviewed_at IS NOT NULL THEN 'Automatic eligibility check' END) reviewer_name FROM leaves l JOIN employees e ON e.id=l.employee_id JOIN leave_types t ON t.id=l.leave_type_id
      LEFT JOIN users u ON u.id=l.reviewed_by ${own ? 'WHERE l.employee_id=?' : ''} ORDER BY l.created_at DESC,l.id DESC`).all(...(own?[req.user.employee_id || -1]:[])));
  });
  app.post('/api/leaves',(req,res)=>{
    const employee=id(req.body.employee_id),type=id(req.body.leave_type_id);
    if(req.user.role === 'user' && req.user.employee_id !== employee) fail('You may apply only for yourself.',403);
    const e=db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(employee);
    const t=db.prepare('SELECT * FROM leave_types WHERE id=? AND active=1').get(type);
    if(!e || !t) fail('Choose an active employee and leave type.');
    const start=req.body.start_date,end=req.body.end_date,half=!!req.body.half_day;
    let days;
    try {days=workingDays(start,end,db.prepare('SELECT date FROM holidays').all().map(h=>h.date),half);} catch(error){fail(error.message);}
    const wellnessLimit=wellnessError(t,start,end);
    if(wellnessLimit) fail(wellnessLimit);
    if(days <= 0) fail('The selected dates contain no working days.');
    const reason=str(req.body.reason,'Reason',2000);
    const rejection=eligibilityReason(e,t);
    const result=transaction(db,()=>{
      if(rejection) {
        const r=db.prepare("INSERT INTO leaves(employee_id,leave_type_id,start_date,end_date,days,half_day,reason,submitted_by,status,review_note,reviewed_at) VALUES(?,?,?,?,?,?,?,?,'rejected',?,datetime('now'))").run(employee,type,start,end,days,half?1:0,reason,req.user.id,'Automatically rejected: '+rejection);
        audit(req.user,'Leave automatically rejected','Request '+r.lastInsertRowid+' · '+e.employee_no+' · '+rejection);
        return r;
      }
      if(db.prepare("SELECT id FROM leaves WHERE employee_id=? AND status IN ('pending','approved') AND start_date<=? AND end_date>=?").get(employee,end,start)) fail('This employee already has a pending or approved leave during these dates.');
      if(db.prepare("SELECT id FROM manual_leave_usage WHERE employee_id=? AND leave_type_id=? AND status IN ('pending','approved') AND deleted_at IS NULL AND usage_date>=? AND usage_date<=?").get(employee,type,start,end)) fail('A manual usage entry already covers this leave type and date. Review the source record to avoid counting it twice.');
      if((t.requires_balance || (isSpecialPrivilege(t)||isWellness(t))) && getCredit(employee,type,Number(start.slice(0,4))).available < days) fail('Insufficient leave credits. Ask HR to review the entitlement.');
      const r=db.prepare('INSERT INTO leaves(employee_id,leave_type_id,start_date,end_date,days,half_day,reason,submitted_by) VALUES(?,?,?,?,?,?,?,?)').run(employee,type,start,end,days,half?1:0,reason,req.user.id);
      audit(req.user,'Submitted leave','Request '+r.lastInsertRowid+' · '+e.employee_no+' · '+days+' days');
      return r;
    });
    res.status(201).json({id:Number(result.lastInsertRowid),days,status:rejection?'rejected':'pending',review_note:rejection?'Automatically rejected: '+rejection:''});
  });
  app.patch('/api/leaves/:id/status',(req,res)=>{
    const leave=id(req.params.id),status=req.body.status;
    if(!['approved','rejected','cancelled'].includes(status)) fail('Invalid decision.');
    const note=str(req.body.note || '','Review note',1000,status !== 'rejected');
    transaction(db,()=>{
      const row=db.prepare('SELECT l.*,t.requires_balance,t.gender_eligibility,t.name leave_type_name,t.code leave_type_code,e.gender FROM leaves l JOIN leave_types t ON t.id=l.leave_type_id JOIN employees e ON e.id=l.employee_id WHERE l.id=?').get(leave);
      if(!row) fail('Leave request not found.',404);
      if(req.user.role === 'user' && (row.employee_id !== req.user.employee_id || status !== 'cancelled' || row.status !== 'pending')) fail('You can cancel only your own pending requests.',403);
      if(status !== 'cancelled' && row.status !== 'pending') fail('This request has already been reviewed.',409);
      if(status === 'cancelled' && !['pending','approved'].includes(row.status)) fail('This request cannot be cancelled.',409);
      if(status === 'approved') {
        const limit=wellnessError({name:row.leave_type_name,code:row.leave_type_code},row.start_date,row.end_date);
        if(limit) fail(limit);
        const rejection=eligibilityReason({gender:row.gender},{name:row.leave_type_name,gender_eligibility:row.gender_eligibility});
        if(rejection) fail('Cannot approve this application. '+rejection);
        if(row.submitted_by === req.user.id || row.employee_id === req.user.employee_id) fail('A different HR officer or administrator must approve your request.',403);
        if((row.requires_balance || (isSpecialPrivilege({name:row.leave_type_name,code:row.leave_type_code})||isWellness({name:row.leave_type_name,code:row.leave_type_code}))) && getCredit(row.employee_id,row.leave_type_id,Number(row.start_date.slice(0,4))).available < 0) fail('Insufficient leave credits.');
      }
      db.prepare("UPDATE leaves SET status=?,review_note=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=?").run(status,note,req.user.id,leave);
      audit(req.user,'Leave '+status,'Request '+leave+(note?' · '+note:''));
    });
    res.json({ok:true});
  });
  app.get('/api/users',admin,(req,res)=>res.json(db.prepare('SELECT id,username,name,role,employee_id,active,must_change_password FROM users ORDER BY id').all()));
  app.post('/api/users',admin,(req,res)=>{
    const username=str(req.body.username,'Username',60);
    if(!/^[a-zA-Z0-9_.-]+$/.test(username)) fail('Username may contain letters, numbers, dots, hyphens and underscores.');
    const name=str(req.body.name,'Name',100),role=req.body.role;
    if(!['admin','hr','user'].includes(role)) fail('Invalid role.');
    const employee=req.body.employee_id ? id(req.body.employee_id) : null;
    if(role === 'user' && !employee) fail('Employee accounts must link to an employee record.');
    if(employee && !db.prepare('SELECT id FROM employees WHERE id=? AND active=1').get(employee)) fail('Active employee not found.');
    const password=passwordValue(req.body.password);
    const result=transaction(db,()=>{const r=db.prepare('INSERT INTO users(username,name,password_hash,role,employee_id) VALUES(?,?,?,?,?)').run(username,name,hashPassword(password),role,employee);audit(req.user,'Created account',username+' · '+role);return r;});
    res.status(201).json({id:Number(result.lastInsertRowid)});
  });
  app.patch('/api/users/:id',admin,(req,res)=>{
    const target=id(req.params.id);
    if(target === req.user.id) fail('You cannot disable or reset your own account here.');
    if(!db.prepare('SELECT id FROM users WHERE id=?').get(target)) fail('Account not found.',404);
    transaction(db,()=>{
      if(typeof req.body.active === 'boolean') {
        const existing=db.prepare('SELECT * FROM users WHERE id=?').get(target);
        if(!req.body.active && existing.role === 'admin' && db.prepare("SELECT COUNT(*) count FROM users WHERE role='admin' AND active=1").get().count <= 1) fail('Keep at least one active administrator.');
        db.prepare('UPDATE users SET active=? WHERE id=?').run(req.body.active?1:0,target);
      } else {
        db.prepare('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?').run(hashPassword(passwordValue(req.body.password)),target);
      }
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(target);
      audit(req.user,'Updated account','User '+target+(typeof req.body.active === 'boolean'?' · active='+req.body.active:' · password reset'));
    });
    res.json({ok:true});
  });
  app.get('/api/audit',staff,(req,res)=>res.json(db.prepare('SELECT a.*,u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300').all()));
  app.use('/api',(req,res)=>res.status(404).json({error:'API endpoint not found.'}));
  const dist=resolve('dist');
  if(serveFrontend && existsSync(resolve(dist,'index.html'))) {
    app.use(express.static(dist));
    app.get('/{*path}',(req,res)=>res.sendFile(resolve(dist,'index.html')));
  } else app.get('/',(req,res)=>res.type('text').send('Agency Leave API is running. Run npm run dev for development or npm run build before npm start.'));
  app.use((error,req,res,next)=>{
    if(error.status) return res.status(error.status).json({error:error.message});
    if(error.code?.startsWith('ERR_SQLITE') && /UNIQUE constraint/.test(error.message)) return res.status(409).json({error:'This employee number, username, linked employee, leave type code, or date already exists.'});
    if(error instanceof SyntaxError) return res.status(400).json({error:'Invalid JSON request.'});
    console.error(error);
    res.status(500).json({error:'An unexpected error occurred. Please try again.'});
  });
  return app;
}


