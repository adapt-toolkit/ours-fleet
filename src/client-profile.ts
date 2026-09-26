import { clientProfilePath, readGatewayClientProfile } from '@ours.network/sdk/client';
export { ClientProfileError } from '@ours.network/sdk/client';
export type ExplicitClientProfile = ReturnType<typeof readGatewayClientProfile>;
export const clientConfigPath = clientProfilePath;
export const readClientProfile = readGatewayClientProfile;
export function clientProfileKey(profile: ExplicitClientProfile): string {
  return `${profile.endpoint}#${profile.expectedInstanceId}`;
}
