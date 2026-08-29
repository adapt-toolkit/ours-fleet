import { FleetError } from '../application/errors.js';
import type {
  ConfigPreviewResult, ConfigWriteResult, FleetConfigService,
} from './fleet-config-service.js';
import type { TopologyDraftStore } from './topology-draft-store.js';
import type { MergedTopology } from './topology-model.js';

/**
 * Fail-closed boundary for the retired topology-sketch configuration format.
 * New configuration is created through explicit typed Role, Brain, and Agent
 * resources; neither preview nor apply interprets or migrates a sketch.
 */

export interface PromoteRequest {
  ids: string[];
  configRevision: string;
  draftRevision?: string;
}

export interface PromotePreview extends ConfigPreviewResult {
  promoted: string[];
}

export interface PromoteResult extends ConfigWriteResult {
  promoted: string[];
  /** False when the config landed but the sketches could not be cleared. */
  draftsCleared: boolean;
  draftRevision: string;
}

export interface TopologyPromoteOptions {
  drafts: TopologyDraftStore;
  configuration: FleetConfigService;
  topology(): Promise<MergedTopology>;
}

export class TopologyPromoteService {
  constructor(_options: TopologyPromoteOptions) {}

  async preview(request: PromoteRequest): Promise<PromotePreview> {
    return await this.reject(request);
  }

  async promote(request: PromoteRequest): Promise<PromoteResult> {
    return await this.reject(request);
  }

  private async reject(request: PromoteRequest): Promise<never> {
    if (!Array.isArray(request.ids) || request.ids.length === 0)
      throw new FleetError('invalid_request', 'name at least one sketch to add to the fleet');

    // Topology sketches are the retired, pre-resource configuration format.  Do
    // not interpret even a well-formed or mixed request: doing so would recreate
    // the implicit Agent -> legacy role mapping that the Role/Brain/Agent cutover
    // removed.  This guard deliberately precedes every topology/configuration
    // read, preview, write, and draft cleanup effect.
    throw new FleetError(
      'incompatible_version',
      'topology sketches use the retired configuration format; create explicit Role, Brain, and Agent resources instead',
      { retryable: false, details: { migration: 'explicit_role_brain_agent_resources' } },
    );
  }
}
