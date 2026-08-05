import { api } from './api';

export async function confirmAndRemoveRole(role: string): Promise<any | undefined> {
  const preview: any = await api.get(`/api/v1/roles/${encodeURIComponent(role)}/removal-preview`);
  if (preview.selfProtected) throw new Error('This is the current control role and cannot remove itself.');
  const summary = [`Remove ${preview.role}?`, '', ...preview.effects, '',
    `Recovery: ${preview.recovery.detail}`].join('\n');
  if (!confirm(summary)) return undefined;
  let coordinatorAcknowledged = false;
  if (preview.coordinatorProtection) {
    coordinatorAcknowledged = confirm(`${preview.role} coordinates other configured roles. Remove it anyway?`);
    if (!coordinatorAcknowledged) return undefined;
  }
  const confirmation = preview.confirmation === 'typed-role-name'
    ? prompt(`Type ${preview.role} exactly to confirm`) ?? '' : undefined;
  if (preview.confirmation === 'typed-role-name' && confirmation !== preview.role) return undefined;
  return api.post(`/api/v1/roles/${encodeURIComponent(role)}/remove`, {
    confirmation, confirmed: preview.confirmation === 'confirm', coordinatorAcknowledged,
  });
}
