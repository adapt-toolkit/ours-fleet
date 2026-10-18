/** Syntax validation for an authority already selected by trusted private state/configuration. */
export function validateAccountOrigin(value:unknown):string {
  let url:URL;
  try { if(typeof value!=='string')throw Error(); url=new URL(value); } catch { throw Error('Unsupported account origin'); }
  if(url.protocol!=='https:' || url.origin!==value || url.username || url.password)throw Error('Unsupported account origin');
  return value as string;
}
/** Incoming grants/payloads must match explicit operator configuration before any network action. */
export function validateConfiguredAccountOrigin(value:unknown):string {
  const configured=validateAccountOrigin(process.env.OURS_ACCOUNT_ORIGIN);
  if(value!==configured)throw Error('Unsupported account origin');
  return configured;
}
const dnsName=(value:unknown):value is string=>typeof value==='string' && value.length<=253 && value.includes('.') && value.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
export function validateConfiguredWorkspaceHost(value:unknown):boolean {
  if(!dnsName(value))return false;
  if(process.env.OURS_WORKSPACE_HOST!==undefined)return dnsName(process.env.OURS_WORKSPACE_HOST) && value===process.env.OURS_WORKSPACE_HOST;
  const domain=process.env.OURS_WORKSPACE_DOMAIN;
  return dnsName(domain) && value.endsWith('.'+domain) && !value.slice(0,-domain.length-1).includes('.');
}
