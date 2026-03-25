import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: {
        mainKey: "main",
        scope: "per-sender",
        agentToAgent: { maxPingPongTurns: 2 },
      },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true },
      },
    }),
  };
});

import "./test-helpers/fast-core-tools.js";
import { __testing as openClawToolsTesting, createOpenClawTools } from "./openclaw-tools.js";

async function createWorkspace(name: string, identity: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-worker-${name}-`));
  await fs.writeFile(path.join(dir, "IDENTITY.md"), identity, "utf8");
  return dir;
}

function createConfig(workspaces: {
  coordinator: string;
  pm: string;
  frontend: string;
  backend: string;
}): OpenClawConfig {
  return {
    session: {
      mainKey: "main",
      scope: "per-sender",
      agentToAgent: { maxPingPongTurns: 2 },
    },
    tools: {
      sessions: { visibility: "all" },
      agentToAgent: {
        enabled: true,
        allow: ["coordinator", "pm", "frontend"],
      },
    },
    agents: {
      defaults: {
        model: { primary: "manifest/auto" },
      },
      list: [
        {
          id: "coordinator",
          default: true,
          workspace: workspaces.coordinator,
          subagents: { allowAgents: ["pm", "frontend", "backend"] },
        },
        {
          id: "pm",
          name: "Program Manager",
          workspace: workspaces.pm,
        },
        {
          id: "frontend",
          name: "Frontend Builder",
          workspace: workspaces.frontend,
        },
        {
          id: "backend",
          name: "Backend Builder",
          workspace: workspaces.backend,
        },
      ],
    },
  } as OpenClawConfig;
}

describe("workers tools", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("workers_list returns routable named workers with capability summaries", async () => {
    const workspaces = {
      coordinator: await createWorkspace("coordinator", "# coordinator\n"),
      pm: await createWorkspace(
        "pm",
        [
          "# PM",
          "- Name: PM",
          "- Vibe: sharp and strategic",
          "Owns planning, scope, and delivery risk.",
        ].join("\n"),
      ),
      frontend: await createWorkspace(
        "frontend",
        [
          "# Frontend",
          "- Name: Frontend",
          "- Theme: product UI",
          "Builds interface, interaction, and polish.",
        ].join("\n"),
      ),
      backend: await createWorkspace(
        "backend",
        ["# Backend", "- Name: Backend", "Owns APIs and data pipelines."].join("\n"),
      ),
    };
    const config = createConfig(workspaces);
    openClawToolsTesting.setDepsForTest({
      config,
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:coordinator:main",
    }).find((entry) => entry.name === "workers_list");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing workers_list tool");
    }

    const result = await tool.execute("call-workers-list", {});
    const details = result.details as {
      requester?: string;
      workers?: Array<{ id?: string; capabilitySummary?: string }>;
      blocked?: Array<{ id?: string; reasonText?: string[] }>;
    };

    expect(details.requester).toBe("coordinator");
    expect(details.workers?.map((entry) => entry.id)).toEqual(["pm", "frontend"]);
    expect(details.workers?.[0]?.capabilitySummary).toContain("sharp and strategic");
    expect(details.workers?.[1]?.capabilitySummary).toContain("Builds interface");
    expect(details.blocked?.map((entry) => entry.id)).toEqual(["backend"]);
    expect(details.blocked?.[0]?.reasonText).toContain("denied by tools.agentToAgent.allow");
  });

  it("workers_dispatch creates a persistent worker session and waits for the reply", async () => {
    const workspaces = {
      coordinator: await createWorkspace("coordinator", "# coordinator\n"),
      pm: await createWorkspace("pm", "# PM\n"),
      frontend: await createWorkspace("frontend", "# Frontend\nBuilds product UI.\n"),
      backend: await createWorkspace("backend", "# Backend\n"),
    };
    const config = createConfig(workspaces);
    openClawToolsTesting.setDepsForTest({
      config,
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });

    callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: Record<string, unknown> }) => {
        if (request.method === "sessions.list") {
          return { sessions: [] };
        }
        if (request.method === "sessions.create") {
          return { key: request.params?.key };
        }
        if (request.method === "sessions.patch") {
          return { ok: true };
        }
        if (request.method === "sessions.send") {
          return { runId: "worker-run-1", status: "started" };
        }
        if (request.method === "agent.wait") {
          return { status: "ok" };
        }
        if (request.method === "chat.history") {
          return {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "frontend complete" }],
              },
            ],
          };
        }
        return {};
      },
    );

    const tool = createOpenClawTools({
      agentSessionKey: "agent:coordinator:main",
    }).find((entry) => entry.name === "workers_dispatch");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing workers_dispatch tool");
    }

    const result = await tool.execute("call-workers-dispatch", {
      agentId: "frontend",
      task: "Implement the settings page shell.",
      wait: true,
      timeoutSeconds: 5,
    });
    const details = result.details as {
      status?: string;
      created?: boolean;
      sessionKey?: string;
      reply?: string;
      runId?: string;
    };

    expect(details.status).toBe("ok");
    expect(details.created).toBe(true);
    expect(details.sessionKey).toMatch(/^agent:frontend:subagent:/);
    expect(details.reply).toBe("frontend complete");
    expect(details.runId).toBe("worker-run-1");

    const patchCall = callGatewayMock.mock.calls.find(
      ([request]) => (request as { method?: string }).method === "sessions.patch",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    expect(patchCall?.params?.spawnedBy).toBe("agent:coordinator:main");
    expect(patchCall?.params?.subagentRole).toBe("leaf");
    expect(patchCall?.params?.subagentControlScope).toBe("none");
    expect(patchCall?.params?.spawnDepth).toBe(1);
  });

  it("workers_dispatch reuses the freshest existing worker session and can steer it", async () => {
    const workspaces = {
      coordinator: await createWorkspace("coordinator", "# coordinator\n"),
      pm: await createWorkspace("pm", "# PM\n"),
      frontend: await createWorkspace("frontend", "# Frontend\n"),
      backend: await createWorkspace("backend", "# Backend\n"),
    };
    const config = createConfig(workspaces);
    openClawToolsTesting.setDepsForTest({
      config,
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });

    callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: Record<string, unknown> }) => {
        if (request.method === "sessions.list") {
          return {
            sessions: [
              { key: "agent:pm:subagent:older", updatedAt: 10 },
              { key: "agent:pm:subagent:newer", updatedAt: 20 },
            ],
          };
        }
        if (request.method === "sessions.steer") {
          return { runId: "worker-run-2", status: "started" };
        }
        return {};
      },
    );

    const tool = createOpenClawTools({
      agentSessionKey: "agent:coordinator:main",
    }).find((entry) => entry.name === "workers_dispatch");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing workers_dispatch tool");
    }

    const result = await tool.execute("call-workers-reuse", {
      agentId: "pm",
      task: "Re-scope milestone two.",
      interruptRunning: true,
    });
    const details = result.details as {
      status?: string;
      created?: boolean;
      sessionKey?: string;
      duplicateSessions?: number;
      dispatchMode?: string;
    };

    expect(details.status).toBe("accepted");
    expect(details.created).toBe(false);
    expect(details.sessionKey).toBe("agent:pm:subagent:newer");
    expect(details.duplicateSessions).toBe(2);
    expect(details.dispatchMode).toBe("steer");

    const methods = callGatewayMock.mock.calls.map(
      ([request]) => (request as { method?: string }).method,
    );
    expect(methods).toContain("sessions.steer");
    expect(methods).not.toContain("sessions.create");
  });
});
