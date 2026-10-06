export const annualCreditPolicy = {daysPerYear:15,daysPerMonth:1.25,carryForward:true,waitingMonths:6};
export function businessDate(now=new Date()) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
export function annualLeaveKey(type) {
  const code=String(type?.code || '').trim().toUpperCase();
  const name=String(type?.name || '').trim().toLowerCase().replace(/\s+/g,' ');
  if(code==='VL' || name==='vacation leave') return 'vacation';
  if(code==='SL' || name==='sick leave') return 'sick';
  return null;
}
export function completedMonths(appointment, asOf) {
  if(!appointment || !asOf || appointment>asOf) return 0;
  const [sy,sm,sd]=appointment.split('-').map(Number);
  const [ey,em]=asOf.split('-').map(Number);
  let months=(ey-sy)*12+em-sm;
  const anniversaryYear=sy+Math.floor((sm-1+months)/12);
  const anniversaryMonth=(sm-1+months)%12;
  const lastDay=new Date(Date.UTC(anniversaryYear,anniversaryMonth+1,0)).getUTCDate();
  const anniversary=[anniversaryYear,String(anniversaryMonth+1).padStart(2,'0'),String(Math.min(sd,lastDay)).padStart(2,'0')].join('-');
  if(anniversary>asOf) months--;
  return Math.max(0,months);
}
export function earnedForYear(appointment, year, asOf=businessDate()) {
  const cutoff=asOf < year+'-12-31' ? asOf : year+'-12-31';
  if(cutoff < year+'-01-01' || appointment>cutoff) return 0;
  const beforeYear=(year-1)+'-12-31';
  return Math.min(12,Math.max(0,accrualMonths(appointment,cutoff)-accrualMonths(appointment,beforeYear)))*annualCreditPolicy.daysPerMonth;
}

export function accrualMonths(appointment,asOf) {
  return Math.max(0,completedMonths(appointment,asOf)-annualCreditPolicy.waitingMonths);
}
export function isSpecialPrivilege(type) {
  const name=String(type?.name || '').trim().toLowerCase().replace(/\s+/g,' ');
  return String(type?.code || '').toUpperCase()==='SPL' || ['special privilege leave','special privelege leave'].includes(name);
}
export function isWellness(type) {
  return String(type?.code || '').toUpperCase()==='WEL' || String(type?.name || '').trim().toLowerCase()==='wellness leave';
}
export function wellnessError(type,start,end) {
  if(!isWellness(type)) return '';
  const span=(Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86400000+1;
  return span>3 ? 'Wellness leave is limited to 3 consecutive calendar days per application.' : '';
}
