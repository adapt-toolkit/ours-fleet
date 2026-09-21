import type { OursClient } from "@ours.network/sdk/client";
import { RuntimeJournal, type RuntimeState, type Phase } from "./state.js";

export interface AssignedIdentity {
  instance: string;
  generation: number;
  daemon: string;
  name: string;
  lifetime: "permanent" | "temporary";
  action: string;
  expectedCid?: string;
  allowCreate: boolean;
  bio: string;
}
export interface RoomAdmission {
  id: string;
  cid: string;
  seat: string;
  action: string;
  /** The secret stays in trusted storage and is never returned to the child. */
  redeem(client: OursClient): Promise<{ cid: string }>;
  observe(agentCid: string): Promise<"pending" | "established" | "mismatch">;
  discardSecret(): Promise<void>;
}
export interface RuntimeDependencies {
  journal: RuntimeJournal;
  /** Client is already attached to the pinned daemon with its durable external owner. */
  client: OursClient;
  /** Checked before every operation; tied to the cross-process controller lock. */
  assertFence(): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}
/** A bridge never owns this object or its client; EOF never releases its lease. */
export class AgentOursRuntime {
  private inFlight = 0;
  private drain?: () => void;
  private accepting = false;
  private state: RuntimeState;
  constructor(
    readonly assignment: AssignedIdentity,
    private readonly deps: RuntimeDependencies,
  ) {
    const existing = deps.journal.read();
    if (existing) {
      if (
        existing.instance !== assignment.instance ||
        existing.daemon !== assignment.daemon ||
        existing.name !== assignment.name ||
        existing.lifetime !== assignment.lifetime ||
        existing.generation !== assignment.generation ||
        existing.action !== assignment.action ||
        (assignment.expectedCid !== undefined &&
          existing.cid !== undefined &&
          existing.cid !== assignment.expectedCid)
      )
        throw Error("RUNTIME_ASSIGNMENT_MISMATCH");
      this.state = existing;
    } else {
      // Deliberately serialize only the public ownership facts, never credentials.
      const { instance, generation, daemon, name, lifetime, action } =
        assignment;
      this.state = {
        version: 1,
        instance,
        generation,
        daemon,
        name,
        lifetime,
        action,
        phase: "PREPARING",
        revision: 0,
        updatedAt: "",
      };
      deps.assertFence();
      deps.journal.commit(this.state);
      this.state = deps.journal.read()!;
    }
  }
  get snapshot(): Readonly<RuntimeState> {
    return structuredClone(this.state);
  }
  private transition(phase: Phase, patch: Partial<RuntimeState> = {}): void {
    this.deps.assertFence();
    this.deps.journal.commit(
      { ...this.state, ...patch, phase },
      this.state.revision,
    );
    this.state = this.deps.journal.read()!;
  }
  private async verify(): Promise<void> {
    this.deps.assertFence();
    if (
      this.assignment.expectedCid &&
      this.state.cid !== this.assignment.expectedCid
    )
      throw Error("PINNED_CID_MISMATCH");
    const actual = await this.deps.client.currentIdentity();
    if (
      actual.cid !== this.state.cid ||
      actual.name !== this.state.name ||
      actual.temporary !== (this.state.lifetime === "temporary") ||
      actual.isRoot
    )
      throw Error("IDENTITY_PROOF_MISMATCH");
    this.deps.assertFence();
  }
  async prepare(room?: RoomAdmission, timeoutMs = 30_000): Promise<void> {
    if (
      [
        "TERMINAL_INTENT",
        "CLEANUP_PENDING",
        "RELEASED",
        "FAILED",
        "QUIESCING",
      ].includes(this.state.phase)
    )
      throw Error("RUNTIME_NOT_RESUMABLE");
    this.deps.assertFence();
    if (!this.state.cid) {
      // An existing PREPARING journal is an uncertain create, never evidence of absence.
      if (this.state.phase === "RECOVERING")
        throw Error("UNCERTAIN_PROVISIONING");
      const rows = await this.deps.client.listIdentities();
      const row = rows.find((r) => r.name === this.state.name);
      if (row) {
        if (
          !("cid" in row) ||
          this.state.lifetime === "temporary" ||
          !this.assignment.expectedCid ||
          row.cid !== this.assignment.expectedCid ||
          row.kind === "root" ||
          row.temp
        )
          throw Error("IDENTITY_COLLISION");
        this.transition("RECOVERING");
        await this.deps.client.chooseIdentity({
          name: this.state.name,
          force: false,
        });
        this.transition("OWNED", { cid: row.cid });
      } else {
        if (!this.assignment.allowCreate || this.assignment.expectedCid)
          throw Error("IDENTITY_ABSENT");
        // Persist uncertainty before the non-idempotent call. Crash recovery requires owner proof.
        this.transition("RECOVERING");
        const args = {
          name: this.state.name,
          bio: this.assignment.bio,
          exposeLocal: false,
          localAutoAccept: true,
        };
        const created =
          this.state.lifetime === "temporary"
            ? await this.deps.client.createTemporaryIdentity(args)
            : await this.deps.client.createIdentity(args);
        if (created.hierarchy !== "role")
          throw Error("ROOT_PROVISIONING_FORBIDDEN");
        this.transition("OWNED", { cid: created.info.cid });
      }
    }
    await this.verify();
    if (!room && (this.state.room || this.state.admissionIntent))
      throw Error("ROOM_DESCRIPTOR_REQUIRED");
    if (room) {
      if (
        this.state.room &&
        (this.state.room.id !== room.id ||
          this.state.room.cid !== room.cid ||
          this.state.room.seat !== room.seat ||
          this.state.room.agentCid !== this.state.cid ||
          this.state.room.action !== room.action)
      )
        throw Error("ROOM_ASSIGNMENT_MISMATCH");
      const intent = this.state.admissionIntent;
      if (
        intent &&
        (intent.id !== room.id ||
          intent.cid !== room.cid ||
          intent.seat !== room.seat ||
          intent.action !== room.action ||
          intent.agentCid !== this.state.cid)
      )
        throw Error("ROOM_INTENT_MISMATCH");
      if (!this.state.room && !intent) {
        // A permanent identity may already occupy its seat after a clean supervisor stop.
        const existing = await room.observe(this.state.cid!);
        if (existing === "mismatch") {
          this.transition("FAILED");
          throw Error("WRONG_ROOM_SEAT");
        }
        this.transition("ROOM_PENDING", {
          admissionIntent: {
            id: room.id,
            cid: room.cid,
            seat: room.seat,
            action: room.action,
            agentCid: this.state.cid!,
          },
        });
        if (existing !== "established") {
          const result = await room.redeem(this.deps.client);
          if (result.cid !== room.cid) {
            this.transition("FAILED");
            throw Error("WRONG_ROOM_CID");
          }
        }
      }
      const deadline = this.deps.now() + timeoutMs;
      for (;;) {
        this.deps.assertFence();
        const observation = await room.observe(this.state.cid!);
        if (observation === "mismatch") {
          this.transition("FAILED");
          throw Error("WRONG_ROOM_SEAT");
        }
        if (observation === "established") break;
        if (this.deps.now() >= deadline) throw Error("ROOM_PENDING");
        await this.deps.sleep(Math.min(250, deadline - this.deps.now()));
      }
      this.transition("READY", {
        room: {
          id: room.id,
          cid: room.cid,
          seat: room.seat,
          agentCid: this.state.cid!,
          action: room.action,
        },
      });
      await room.discardSecret();
    } else this.transition("READY");
    this.accepting = true;
  }
  /** Admission covers SDK calls, response rendering and agent filesystem callbacks. */
  async admit(): Promise<() => void> {
    this.deps.assertFence();
    if (!this.accepting || !["READY", "SERVING"].includes(this.state.phase))
      throw Error("RUNTIME_NOT_READY");
    this.inFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--this.inFlight === 0) this.drain?.();
    };
    try {
      await this.verify();
      if (!this.accepting) throw Error("RUNTIME_QUIESCING");
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  async startHarness<T>(start: () => Promise<T>): Promise<T> {
    if (!this.accepting || this.state.phase !== "READY")
      throw Error("RUNTIME_NOT_READY");
    await this.verify();
    this.transition("SERVING");
    return start();
  }
  async suspend(): Promise<void> {
    this.accepting = false;
    if (this.inFlight)
      await new Promise<void>((resolve) => {
        this.drain = resolve;
      });
    this.transition("RECOVERING");
  }
  async terminal(): Promise<void> {
    this.accepting = false;
    if (this.state.phase === "RELEASED") return;
    if (!["TERMINAL_INTENT", "CLEANUP_PENDING"].includes(this.state.phase))
      this.transition("QUIESCING");
    if (this.inFlight)
      await new Promise<void>((resolve) => {
        this.drain = resolve;
      });
    this.transition("TERMINAL_INTENT");
    try {
      this.deps.assertFence();
      const ack = await this.deps.client.releaseLease();
      if (
        !ack ||
        !Array.isArray(ack.released) ||
        !Array.isArray(ack.closed) ||
        [...ack.released, ...ack.closed].some(
          (name) => typeof name !== "string",
        ) ||
        [ack.attempted, ack.notified, ack.failed].some(
          (n) => !Number.isSafeInteger(n) || n < 0,
        ) ||
        ack.notified + ack.failed !== ack.attempted
      )
        throw Error("INVALID_RELEASE_ACK");
      this.transition("RELEASED", { releaseAck: ack });
    } catch (error) {
      this.transition("CLEANUP_PENDING");
      throw error;
    }
  }
}
