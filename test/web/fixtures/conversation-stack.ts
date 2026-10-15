import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpSession } from "../../../src/session/acp.js";
import { CodexAppServerSession } from "../../../src/session/codex-app-server.js";
import { FakeAppServer } from "../../fixtures/codex-app-server.js";
import { RoleControlServer } from "../../../src/session/control.js";
import { AcpRoleSessionAdapter } from "../../../src/application/session-control.js";
import type { ConversationRoleState } from "../../../src/application/conversation-role-observer.js";
import { AuditSink } from "../../../src/web/audit.js";
import { TrustedDeviceStore } from "../../../src/web/device-store.js";
import { WebAuth } from "../../../src/web/auth.js";
import { buildWebServer } from "../../../src/web/server.js";
const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/acp-agent.mjs",
);

/**
 * Shared real HTTP/private-control/session stack. Role metadata is a controlled
 * fixture input; external agents use the ACP child or native Codex protocol driver.
 */
export async function startConversationStack(
  env: Record<string, string> = {},
  backend: "acp" | "codex" = "acp",
  approval: "ask" | "allow" = "allow",
) {
  const cleanups: Array<() => Promise<void> | void> = [];
  const dispose = async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  };
  try {
    const stateDir = mkdtempSync(join(tmpdir(), "ours-conv-real-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const common = {
      name: "Alpha",
      argv: [process.execPath, fixture],
      cwd: stateDir,
      env,
      stateDir,
      mode: "fresh",
      permissions: { approval, filesystem: "workspace", unattended: "wait" },
      log: () => {},
    } as const;
    const startSession = async () =>
      backend === "acp"
        ? await AcpSession.start(common)
        : await CodexAppServerSession.start(
            {
              ...common,
              argv: ["codex", "app-server"],
              permissionMode: { fleetMode: "ask", nativeMode: "untrusted" },
              model: "gpt-fixture",
              effort: "medium",
              approvalPolicy: "untrusted",
              sandbox: "workspace-write",
            },
            async (options) => new FakeAppServer(options),
          );
    let session = await startSession();
    cleanups.push(() => session.close());
    let control = new RoleControlServer(stateDir, session, () => {});
    await control.start();
    cleanups.push(() => control.close());

    const role = {
      id: "Alpha",
      lifetime: "permanent",
      configured: true,
      stateHealth: "present",
      configuredBackend: backend,
      detectedBackend: backend,
      compatibility: { compatible: true },
      problems: [],
    };
    const webDir = mkdtempSync(join(tmpdir(), "ours-conv-real-web-"));
    cleanups.push(() => rmSync(webDir, { recursive: true, force: true }));
    const auth = new WebAuth(
      "http://placeholder",
      "placeholder",
      Date.now,
      new TrustedDeviceStore(webDir),
    );
    const observers = new Set<(state: ConversationRoleState) => void>();
    const roleState: ConversationRoleState = {
      roleId: "Alpha",
      roleRevision: 1,
      roleLifetime: "fixture-life",
      availability: "available",
      health: "healthy",
      stateDir,
    };
    const changeRole = (change: Partial<ConversationRoleState>) => {
      Object.assign(roleState, change, {
        roleRevision: roleState.roleRevision + 1,
      });
      for (const listener of observers) listener({ ...roleState });
    };
    const server = await buildWebServer(
      {
        observeRole(
          _id: string,
          listener: (state: ConversationRoleState) => void,
        ) {
          observers.add(listener);
          return {
            snapshot: () => ({ ...roleState }),
            subscribe(next: (state: ConversationRoleState) => void) {
              observers.add(next);
              return {
                snapshot: { ...roleState },
                unsubscribe: () => observers.delete(next),
              };
            },
            dispose() {
              observers.delete(listener);
            },
          };
        },
        query: {
          async list() {
            return [];
          },
          async detail() {
            return { role, status: {}, capabilities: {} };
          },
        },
        repository: {
          async get() {
            return role;
          },
          stateDir: () => stateDir,
        },
        async session() {
          return new AcpRoleSessionAdapter(stateDir);
        },
        logs: {
          source: () => ({
            tail: async () => ({ records: [], truncated: false }),
          }),
        },
        commands: {
          async execute() {
            return {};
          },
          get() {
            return undefined;
          },
        },
        creation: {
          async capabilities() {
            return {};
          },
          async preview() {
            return {};
          },
          async create() {
            return {};
          },
          get() {
            return undefined;
          },
        },
        audit: new AuditSink(join(webDir, "audit")),
      } as never,
      { origin: "http://placeholder", host: "placeholder" },
      { auth },
    );
    cleanups.push(() => server.close());
    const address = await server.app.listen({ host: "127.0.0.1", port: 0 });
    const port = new URL(address).port;
    const origin = `http://127.0.0.1:${port}`;
    auth.setBoundary(origin, `127.0.0.1:${port}`);

    const exchange = await fetch(`${origin}/api/v1/auth/exchange`, {
      method: "POST",
      headers: {
        origin,
        authorization: `Bootstrap ${server.auth.bootstrapSecret}`,
      },
    });
    assert.equal(exchange.ok, true);
    const cookie = (exchange.headers.getSetCookie?.() ?? [])
      .map((value) => value.split(";")[0])
      .join("; ");
    const csrf = ((await exchange.json()) as { csrfToken: string }).csrfToken;
    const jsonHeaders = {
      origin,
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    return {
      origin,
      cookie,
      csrf,
      jsonHeaders,
      get session() {
        return session;
      },
      stateDir,
      auth,
      server,
      changeRole,
      observers,
      dispose,
      async replaceGeneration() {
        changeRole({ availability: "unavailable" });
        await control.close();
        await session.close();
        session = await startSession();
        control = new RoleControlServer(stateDir, session, () => {});
        await control.start();
        changeRole({ availability: "available", roleLifetime: "replacement" });
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
