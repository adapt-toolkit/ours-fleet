import type {
  CodexAppServerConnection,
  CodexAppServerTransportOptions,
} from "../../src/session/codex-app-server-transport.js";

export class FakeAppServer implements CodexAppServerConnection {
  /** Turns whose first input matches stay running until `finishHeld()` or turn/interrupt. */
  holdMatching?: (text: string) => boolean;
  private readonly held = new Set<string>();
  finishHeld(): void {
    for (const turnId of [...this.held]) { this.held.delete(turnId); this.complete(turnId, "native final"); }
  }
  readonly pid = 4242;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  readonly requests: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  readonly child = {
    kill: (signal?: NodeJS.Signals | number) => {
      this.signals.push(signal);
      if (this.ignoreSigterm && signal === "SIGTERM") return true;
      this.alive = false;
      this.options.onExit?.({
        version: 1,
        class: "program-exit",
        detail: `fixture exited via ${String(signal)}`,
      });
      return true;
    },
  };
  private alive = true;
  private turn = 0;
  private ignoreSigterm = false;
  private threadStatus = "idle";
  private readonly turns = new Map<string, Record<string, unknown>>();
  private approvalTurn?: {
    requestId: number;
    turnId: string;
    kind: "operation" | "permissions";
  };
  constructor(private readonly options: CodexAppServerTransportOptions) {}

  isAlive() {
    return this.alive;
  }
  exitResult() {
    return null;
  }
  notify() {}
  respondError() {}
  async close() {
    this.alive = false;
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.requests.push({ method, params });
    if (method === "initialize") return { userAgent: "fixture" } as T;
    if (method === "thread/start" || method === "thread/resume")
      return {
        thread: {
          id: method === "thread/resume" ? params.threadId : "thread-native-1",
        },
        model: params.model ?? "fixture-model",
        reasoningEffort: "medium",
        cwd: params.cwd,
      } as T;
    if (method === "turn/start") {
      const turnId = `turn-${++this.turn}`;
      const input = params.input as Array<{ text?: string }>;
      this.turns.set(turnId, {
        id: turnId,
        status: "inProgress",
        items: [],
        error: null,
      });
      queueMicrotask(() => {
        this.options.onNotification?.("turn/started", {
          threadId: "thread-native-1",
          turn: { id: turnId, status: "inProgress" },
        });
        if (this.holdMatching?.(input[0]?.text ?? "")) {
          this.held.add(turnId);
        } else if (input[0]?.text?.includes("additional permission")) {
          const requestId = 900 + this.turn;
          this.approvalTurn = { requestId, turnId, kind: "permissions" };
          this.options.onRequest?.(
            "item/permissions/requestApproval",
            requestId,
            {
              threadId: "thread-native-1",
              turnId,
              itemId: `permissions-${turnId}`,
              reason: "network access",
              permissions: {
                network: { enabled: true },
                fileSystem: null,
              },
            },
          );
        } else if (input[0]?.text?.includes("permission")) {
          const requestId = 900 + this.turn;
          this.approvalTurn = { requestId, turnId, kind: "operation" };
          this.options.onRequest?.(
            "item/commandExecution/requestApproval",
            requestId,
            {
              threadId: "thread-native-1",
              turnId,
              itemId: `command-${turnId}`,
              command: "echo approved",
              availableDecisions: ["accept", "decline", "cancel"],
            },
          );
        } else if (input[0]?.text?.includes("system error")) {
          this.options.onNotification?.("thread/status/changed", {
            threadId: "thread-native-1",
            status: { type: "systemError" },
          });
        } else if (input[0]?.text?.includes("ignore interrupt")) {
          this.ignoreSigterm = true;
        } else if (input[0]?.text?.includes("hold running")) {
          // Busy until turn/interrupt: the cooperative long-running turn.
        } else {
          const missingTerminal = input[0]?.text?.includes("missing terminal");
          if (input[0]?.text?.includes("with commentary")) {
            const note = {
              type: "agentMessage",
              id: `commentary-${turnId}`,
              text: "Reading the file first.",
              phase: "commentary",
              memoryCitation: null,
              delivery: null,
            };
            this.options.onNotification?.("item/started", {
              threadId: "thread-native-1",
              turnId,
              item: { ...note, text: "" },
            });
            this.options.onNotification?.("item/agentMessage/delta", {
              threadId: "thread-native-1",
              turnId,
              itemId: note.id,
              delta: note.text,
            });
            this.options.onNotification?.("item/completed", {
              threadId: "thread-native-1",
              turnId,
              item: note,
            });
          }
          this.complete(turnId, "native final", missingTerminal);
          if (input[0]?.text?.includes("stale idle")) {
            this.threadStatus = "active";
            this.turns.set(turnId, {
              id: turnId,
              status: "inProgress",
              items: [],
              error: null,
            });
          }
        }
      });
      return { turn: { id: turnId, status: "inProgress" } } as T;
    }
    if (method === "turn/steer") return { turnId: params.expectedTurnId } as T;
    if (method === "turn/interrupt") {
      if (this.ignoreSigterm) return {} as T;
      this.held.delete(String(params.turnId));
      queueMicrotask(() =>
        this.options.onNotification?.("turn/completed", {
          threadId: "thread-native-1",
          turn: { id: params.turnId, status: "interrupted", error: null },
        }),
      );
      return {} as T;
    }
    if (method === "thread/read")
      return {
        thread: {
          id: "thread-native-1",
          status: { type: this.threadStatus },
          turns: [...this.turns.values()],
        },
      } as T;
    throw new Error(`unexpected method ${method}`);
  }

  respond(id: string | number, result: unknown) {
    if (!this.approvalTurn || this.approvalTurn.requestId !== id) return;
    const { turnId, kind } = this.approvalTurn;
    const decision =
      kind === "permissions"
        ? `scope:${(result as { scope?: string }).scope ?? "unknown"}`
        : ((result as { decision?: string }).decision ?? "unknown");
    this.approvalTurn = undefined;
    queueMicrotask(() => this.complete(turnId, `permission:${decision}`));
  }

  resolveServerRequest(
    threadId = "thread-native-1",
    requestId = this.approvalTurn?.requestId,
  ) {
    if (requestId === undefined) return;
    this.options.onNotification?.("serverRequest/resolved", {
      threadId,
      requestId,
    });
  }

  private complete(turnId: string, text: string, omitTerminal = false) {
    const item = {
      type: "agentMessage",
      id: `message-${turnId}`,
      text,
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
    };
    this.options.onNotification?.("item/started", {
      threadId: "thread-native-1",
      turnId,
      item: { ...item, text: "" },
    });
    this.options.onNotification?.("item/agentMessage/delta", {
      threadId: "thread-native-1",
      turnId,
      itemId: item.id,
      delta: text,
    });
    this.options.onNotification?.("item/completed", {
      threadId: "thread-native-1",
      turnId,
      item,
    });
    this.turns.set(turnId, {
      id: turnId,
      status: "completed",
      items: [item],
      error: null,
    });
    if (omitTerminal) {
      this.options.onNotification?.("thread/status/changed", {
        threadId: "thread-native-1",
        status: { type: "idle" },
      });
      return;
    }
    this.options.onNotification?.("turn/completed", {
      threadId: "thread-native-1",
      turn: { id: turnId, status: "completed", error: null },
    });
  }
}
