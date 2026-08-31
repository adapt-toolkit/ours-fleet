import type { ReportArtifact, ReportKind, ReportRequest, ReportViewModel } from './types.js';
import { createReportArtifact } from './render.js';

export interface AuthorizedReportProvider<T = unknown> {
  readonly surface: 'cli' | 'rest' | 'messenger';
  /** Implementations must authorize and allowlist every returned nested resource. */
  collect(request: ReportRequest, limits: { maxRecords: number }): Promise<SafeSnapshot<T>>;
}

export interface SafeSnapshot<T> {
  /** Data must already be constructed by a per-kind allowlist. */
  data: T;
  observedAt: Record<string, string>;
  unavailable: string[];
  stale: string[];
  bounds: { shown: number; total: number; truncated: boolean };
}

export interface ReportDefinition<R extends ReportRequest = ReportRequest, S = unknown> {
  kind: R['kind'];
  maxRecords: number;
  validate(request: ReportRequest): request is R;
  resourceId(request: R): string | undefined;
  present(request: R, snapshot: SafeSnapshot<S>, generatedAt: string): ReportViewModel;
}

export class ReportRegistry {
  readonly #definitions = new Map<ReportKind, ReportDefinition>();

  register<R extends ReportRequest, S>(definition: ReportDefinition<R, S>): this {
    if (this.#definitions.has(definition.kind)) throw new Error(`duplicate report kind: ${definition.kind}`);
    this.#definitions.set(definition.kind, definition as unknown as ReportDefinition);
    return this;
  }

  get(kind: ReportKind): ReportDefinition {
    const definition = this.#definitions.get(kind);
    if (!definition) throw new Error(`unsupported report kind: ${kind}`);
    return definition;
  }

  kinds(): ReportKind[] {
    return [...this.#definitions.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  }
}

export class FleetReportService {
  constructor(private readonly registry: ReportRegistry, private readonly maxBytes = 5 * 1024 * 1024) {}

  async create(
    request: ReportRequest,
    context: { provider: AuthorizedReportProvider<any>; generatedAt: string },
  ): Promise<ReportArtifact> {
    if (request.viewer.surface !== context.provider.surface) throw new Error('report viewer does not match the authorized provider');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(context.generatedAt)
      || Number.isNaN(Date.parse(context.generatedAt))) throw new Error('generatedAt must be a valid UTC RFC3339 timestamp');
    const definition = this.registry.get(request.kind);
    if (!definition.validate(request)) throw new Error('invalid report selector');
    const resourceId = definition.resourceId(request);
    const snapshot = await context.provider.collect(request, { maxRecords: definition.maxRecords });
    if (snapshot.bounds.shown > definition.maxRecords)
      throw new Error('authorized report provider exceeded the record cap');
    if (snapshot.bounds.total > snapshot.bounds.shown && !snapshot.bounds.truncated)
      throw new Error('authorized report provider exceeded the record cap without truncation');
    const model = definition.present(request, snapshot, context.generatedAt);
    if (model.reportKind !== request.kind) throw new Error('report presenter returned the wrong kind');
    model.observedAt = { ...snapshot.observedAt, ...model.observedAt };
    model.unavailable = [...new Set([...snapshot.unavailable, ...snapshot.stale.map(x => `${x} (stale)`), ...(model.unavailable ?? [])])];
    const visibleTruncation = model.sections.some(section => section.kind === 'task-navigator'
      ? section.panels.some(panel => panel.shown < panel.total)
      : (section.kind === 'table' || section.kind === 'cards' || section.kind === 'records' || section.kind === 'list-board') && Boolean(section.truncated));
    if (snapshot.bounds.truncated && !visibleTruncation)
      throw new Error('report presenter did not disclose snapshot truncation');
    const artifact = createReportArtifact(model, resourceId);
    if (artifact.metadata.byteSize > this.maxBytes) throw new Error(`report exceeds the ${this.maxBytes}-byte artifact limit`);
    return artifact;
  }
}
