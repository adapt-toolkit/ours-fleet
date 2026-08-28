import { DurableAgentGenerationReader } from './agent-generation-reservation.js';
import { readTempAgentSupervisorHandoff } from './temp-agent-supervisor-handoff.js';

const seamBrand:unique symbol=Symbol('TempAgentPrelaunchReservation');
export interface TempAgentPrelaunchReservation {readonly [seamBrand]:true;readonly agentId:string;readonly generation:number}
export interface AuthenticatedTempAgentPrelaunchBindings {agentId:string;generation:number;actionId:string;planDigest:string;
  snapshotDigest:string;reservationDigest:string;canonicalDir:string;authorizationRevision:string;lifetime:'temporary';
  identityLifecycle:'connector_session_owned';completion:'deferred'}
export interface ProductionTempAgentSupervisorRehydration {rehydrate(agentId:string):TempAgentPrelaunchReservation}
export interface InternalTempAgentPrelaunchAuthority extends ProductionTempAgentSupervisorRehydration {
  authenticate(value:TempAgentPrelaunchReservation):Readonly<AuthenticatedTempAgentPrelaunchBindings>|undefined}
/** Read-only prelaunch reservation authentication. It has no Brain, identity, session, or retirement methods. */
export function createInternalTempAgentPrelaunchAuthority(trustedStateRoot:string):InternalTempAgentPrelaunchAuthority{
  const issued=new WeakMap<object,Readonly<AuthenticatedTempAgentPrelaunchBindings>>();const generations=new DurableAgentGenerationReader(trustedStateRoot);
  return Object.freeze({rehydrate(agentId:string){const handoff=readTempAgentSupervisorHandoff(trustedStateRoot,agentId);generations.readExact(handoff);
    const bindings=Object.freeze({agentId:handoff.agentId,generation:handoff.generation,actionId:handoff.actionId,planDigest:handoff.planDigest,
      snapshotDigest:handoff.snapshotDigest,reservationDigest:handoff.reservationDigest,canonicalDir:handoff.canonicalDir,
      authorizationRevision:handoff.authorizationRevision,lifetime:'temporary' as const,
      identityLifecycle:'connector_session_owned' as const,completion:'deferred' as const});const seam=Object.freeze({[seamBrand]:true as const,agentId:handoff.agentId,generation:handoff.generation});
    issued.set(seam,bindings);return seam;},authenticate(value:TempAgentPrelaunchReservation){return issued.get(value as object);}});}
export function createProductionTempAgentSupervisorRehydration(trustedStateRoot:string):ProductionTempAgentSupervisorRehydration{
  const internal=createInternalTempAgentPrelaunchAuthority(trustedStateRoot);
  return Object.freeze({rehydrate:(agentId:string)=>internal.rehydrate(agentId)});
}
