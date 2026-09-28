/** Read-only operations exposed by the identity-owning supervisor. */
export interface AgentHistoryQuery { peer_cid: string; limit?: number; before_seq?: number }
export interface SupervisorCorrespondence {
  contacts(): Promise<unknown>;
  history(request: AgentHistoryQuery): Promise<unknown>;
}
