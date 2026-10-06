export const genderOptions = [
  {value:'not_specified',label:'Not specified'},
  {value:'female',label:'Female'},
  {value:'male',label:'Male'},
  {value:'other',label:'Other'}
];
export const eligibilityOptions = [
  {value:'all',label:'All genders'},
  {value:'female',label:'Female only'},
  {value:'male',label:'Male only'}
];
export const genderLabel = value => genderOptions.find(item=>item.value===value)?.label || 'Not specified';
export const eligibilityLabel = value => eligibilityOptions.find(item=>item.value===value)?.label || 'All genders';
export function suggestedEligibility(name='', code='') {
  if(/\bmaternity\b/i.test(name) || /^(ML|MTL)$/i.test(code)) return 'female';
  if(/\bpaternity\b/i.test(name) || /^(PL|PTL)$/i.test(code)) return 'male';
  return 'all';
}
export function eligibilityReason(employee, type) {
  const rule=type?.gender_eligibility || 'all';
  if(rule==='all' || !employee || employee.gender===rule) return '';
  const requirement=genderLabel(rule);
  if(!employee.gender || employee.gender==='not_specified') return type.name+' requires a '+requirement.toLowerCase()+' employee record. Ask HR to update the employee gender before applying.';
  return type.name+' is configured for '+requirement.toLowerCase()+' employees only. This employee is recorded as '+genderLabel(employee.gender).toLowerCase()+'.';
}
