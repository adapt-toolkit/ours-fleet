import type { ConversationEventV1 } from './session/conversation-types.js';

/** Body-free startup diagnostics. First output is an observation, not proof of useful work. */
export class StartupTelemetry {
  private readonly started: number;
  private promptAt?: number;
  private promptId?: string;
  private firstOutput = false;
  private completed = false;
  private readonly tools = new Set<string>();
  constructor(private readonly now: () => number, private readonly log: (line: string) => void) {
    this.started = now();
  }
  mark(stage: 'supervisor_started' | 'identity_prepare_started' | 'identity_ready' | 'harness_starting' | 'harness_ready' | 'startup_submitted' | 'readiness_turn_completed'): void {
    const at = this.now();
    if (stage === 'startup_submitted') this.promptAt = at;
    this.log(`startup stage=${stage} elapsed_ms=${Math.max(0, at - this.started)}`);
  }
  observe(event: ConversationEventV1): void {
    if (this.promptAt === undefined || this.completed || event.source === 'agent_replay') return;
    if (event.kind === 'prompt.started' && event.source === 'startup') this.promptId = event.promptId;
    if (this.promptId && event.promptId && event.promptId !== this.promptId) return;
    if (event.kind === 'tool.upsert' && 'toolCallId' in event.payload && event.payload.toolCallId)
      this.tools.add(event.payload.toolCallId);
    if (!this.firstOutput && ['message.chunk', 'message.replace'].includes(event.kind)
      && 'role' in event.payload && event.payload.role === 'assistant'
      && 'content' in event.payload && event.payload.content.type === 'text'
      && event.payload.content.text.trim()) {
      this.firstOutput = true;
      const at = this.now();
      this.log(`startup stage=first_assistant_output elapsed_ms=${Math.max(0, at - this.started)} model_and_tools_ms=${Math.max(0, at - this.promptAt)} tools=${this.tools.size}`);
    }
  }
  finish(): void {
    if (this.completed) return;
    this.completed = true;
    this.log(`startup stage=turn_settled elapsed_ms=${Math.max(0, this.now() - this.started)} tools=${this.tools.size} first_output=${this.firstOutput}`);
  }
}
