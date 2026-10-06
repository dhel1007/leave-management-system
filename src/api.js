let csrf = '';
export async function api(path, options = {}) {
  const response = await fetch('/api' + path, {credentials:'same-origin',...options,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,...options.headers},body:options.body === undefined ? undefined : JSON.stringify(options.body)});
  const result = await response.json();
  if(!response.ok) {
    if(response.status === 401 && !['/auth/me','/auth/login'].includes(path)) window.dispatchEvent(new Event('session-expired'));
    throw new Error(result.error || 'Unable to complete the request.');
  }
  if(result.csrf) csrf=result.csrf;
  return result;
}
export const today = () => { const d=new Date(); return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'); };
export function formatDate(value, full=false) { return value ? new Date(value.slice(0,10)+'T00:00:00').toLocaleDateString('en-PH',{month:full?'long':'short',day:'numeric',year:'numeric'}) : '—'; }
export function countDays(start,end,holidays,half) {
  if(!start || !end || start > end || start.slice(0,4)!==end.slice(0,4)) return 0;
  let count=0;
  for(let date=new Date(start+'T00:00:00Z');date<=new Date(end+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+1)) if(![0,6].includes(date.getUTCDay()) && !holidays.some(h=>h.date===date.toISOString().slice(0,10))) count++;
  return half && start===end ? count/2 : count;
}
export function exportCSV(rows) {
  const clean=value=>{let s=String(value ?? ''); if(/^[=+\-@\t\r]/.test(s)) s="'"+s; return '"'+s.replaceAll('"','""')+'"';};
  const data=[['Reference','Employee number','Employee','Department','Leave type','Start','End','Days','Status','Reason','Review note'],...rows.map(r=>['LV-'+String(r.id).padStart(4,'0'),r.employee_no,r.first_name+' '+r.last_name,r.department,r.leave_type,r.start_date,r.end_date,r.days,r.status,r.reason,r.review_note])];
  const url=URL.createObjectURL(new Blob(['\uFEFF'+data.map(row=>row.map(clean).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8;'}));
  const a=document.createElement('a');a.href=url;a.download='leave-register-'+today()+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
