export const accountOrigins = ['https://app.ours.network','https://app.ours-tunnel.com'] as const;
export function validateAccountOrigin(value:unknown):string {
  if(typeof value !== 'string' || !accountOrigins.some(origin=>origin===value))throw Error('Unsupported account origin');
  return value;
}
