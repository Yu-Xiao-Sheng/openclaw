import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../../config/agent-limits.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { runSubagentAnnounceFlow } from "../subagent-announce.js";
import { getSubagentDepthFromSessionStore } from "../subagent-depth.js";
import {
  buildWorkerDirectory,
  buildWorkerSessionLabel,
  describeWorkerAccessReason,
  resolveWorkerRequesterContext,
} from "../worker-directory.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { extractAssistantText, stripToolMessages } from "./sessions-helpers.js";

const WorkersDispatchToolSchema = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  task: Type.String({ minLength: 1 }),
  wait: Type.Optional(Type.Boolean()),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  interruptRunning: Type.Optional(Type.Boolean()),
});

type GatewayCaller = typeof callGateway;

type SessionListRow = {
  key?: string;
  updatedAt?: number;
  status?: string;
};

export const WORKER_DISPATCH_ACCEPTED_NOTE =
  "Named worker completion is push-based. After dispatching workers, do NOT poll sessions_list or sessions_history in a loop. Use sessions_yield to wait for completion events to arrive as follow-up messages, then synthesize the results.";

function buildDispatchMessage(task: string): string {
  return [
    "[Named Worker Dispatch]",
    "This is an internal assignment from your coordinator. Reply with an internal work report, implementation result, test result, or risk note. Do not send a user-facing final reply unless explicitly instructed.",
    "",
    task.trim(),
  ].join("\n");
}

function resolveWorkerAnnounceTimeoutSeconds(params: {
  cfg: OpenClawConfig;
  requestedTimeoutSeconds: number;
}): number {
  const configuredTimeoutSeconds =
    typeof params.cfg.agents?.defaults?.timeoutSeconds === "number" &&
    Number.isFinite(params.cfg.agents.defaults.timeoutSeconds)
      ? Math.max(0, Math.floor(params.cfg.agents.defaults.timeoutSeconds))
      : 600;
  return Math.max(60, configuredTimeoutSeconds, params.requestedTimeoutSeconds);
}

function scheduleWorkerCompletionAnnounce(params: {
  announceCompletion: typeof runSubagentAnnounceFlow;
  requesterSessionKey: string;
  runId: string;
  sessionKey: string;
  task: string;
  timeoutSeconds: number;
}) {
  void params
    .announceCompletion({
      childSessionKey: params.sessionKey,
      childRunId: params.runId,
      requesterSessionKey: params.requesterSessionKey,
      requesterDisplayKey: params.requesterSessionKey,
      task: params.task,
      timeoutMs: Math.max(1, params.timeoutSeconds) * 1000,
      cleanup: "keep",
      waitForCompletion: true,
      expectsCompletionMessage: true,
      spawnMode: "session",
      bestEffortDeliver: true,
    })
    .catch(() => {
      // Best-effort wake path only.
    });
}

function sortSessionsByFreshness(rows: SessionListRow[]): SessionListRow[] {
  return [...rows].toSorted((left, right) => {
    const leftUpdated = typeof left.updatedAt === "number" ? left.updatedAt : 0;
    const rightUpdated = typeof right.updatedAt === "number" ? right.updatedAt : 0;
    if (rightUpdated !== leftUpdated) {
      return rightUpdated - leftUpdated;
    }
    const leftKey = typeof left.key === "string" ? left.key : "";
    const rightKey = typeof right.key === "string" ? right.key : "";
    return leftKey.localeCompare(rightKey);
  });
}

async function findExistingWorkerSession(params: {
  callGateway: GatewayCaller;
  agentId: string;
  requesterInternalKey: string;
  label: string;
}): Promise<{
  sessionKey?: string;
  duplicateCount: number;
}> {
  const listed = await params.callGateway<{ sessions?: SessionListRow[] }>({
    method: "sessions.list",
    params: {
      label: params.label,
      agentId: params.agentId,
      spawnedBy: params.requesterInternalKey,
      limit: 32,
    },
    timeoutMs: 10_000,
  });
  const matches = Array.isArray(listed?.sessions)
    ? listed.sessions.filter((entry): entry is SessionListRow & { key: string } =>
        Boolean(entry && typeof entry === "object" && typeof entry.key === "string" && entry.key),
      )
    : [];
  const sorted = sortSessionsByFreshness(matches);
  return {
    sessionKey: sorted[0]?.key,
    duplicateCount: sorted.length,
  };
}

async function createWorkerSession(params: {
  callGateway: GatewayCaller;
  cfg: OpenClawConfig;
  agentId: string;
  label: string;
  requesterInternalKey: string;
}): Promise<string> {
  const childSessionKey = `agent:${params.agentId}:subagent:${crypto.randomUUID()}`;
  const callerDepth = getSubagentDepthFromSessionStore(params.requesterInternalKey, {
    cfg: params.cfg,
  });
  const childDepth = callerDepth + 1;

  await params.callGateway({
    method: "sessions.create",
    params: {
      key: childSessionKey,
      agentId: params.agentId,
      label: params.label,
      parentSessionKey: params.requesterInternalKey,
    },
    timeoutMs: 10_000,
  });

  try {
    await params.callGateway({
      method: "sessions.patch",
      params: {
        key: childSessionKey,
        spawnedBy: params.requesterInternalKey,
        spawnDepth: childDepth,
        subagentRole: "leaf",
        subagentControlScope: "none",
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    try {
      await params.callGateway({
        method: "sessions.delete",
        params: {
          key: childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: false,
        },
        timeoutMs: 10_000,
      });
    } catch {
      // Best-effort cleanup only.
    }
    throw err;
  }

  return childSessionKey;
}

async function waitForWorkerReply(params: {
  callGateway: GatewayCaller;
  runId: string;
  sessionKey: string;
  timeoutSeconds: number;
}): Promise<
  | {
      status: "ok";
      reply?: string;
    }
  | {
      status: "timeout" | "error";
      error?: string;
    }
> {
  const timeoutMs = Math.max(0, Math.floor(params.timeoutSeconds * 1000));
  let waitStatus: string | undefined;
  let waitError: string | undefined;
  try {
    const wait = await params.callGateway<{ status?: string; error?: string }>({
      method: "agent.wait",
      params: {
        runId: params.runId,
        timeoutMs,
      },
      timeoutMs: timeoutMs + 2_000,
    });
    waitStatus = typeof wait?.status === "string" ? wait.status : undefined;
    waitError = typeof wait?.error === "string" ? wait.error : undefined;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      status: error.includes("gateway timeout") ? "timeout" : "error",
      error,
    };
  }

  if (waitStatus === "timeout") {
    return {
      status: "timeout",
      error: waitError,
    };
  }
  if (waitStatus === "error") {
    return {
      status: "error",
      error: waitError ?? "agent error",
    };
  }

  const history = await params.callGateway<{ messages?: Array<unknown> }>({
    method: "chat.history",
    params: {
      sessionKey: params.sessionKey,
      limit: 50,
    },
    timeoutMs: 10_000,
  });
  const messages = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
  const lastAssistant = [...messages].toReversed().find((message) => {
    return Boolean(
      message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "assistant",
    );
  });
  return {
    status: "ok",
    reply: lastAssistant ? extractAssistantText(lastAssistant) : undefined,
  };
}

export function createWorkersDispatchTool(opts?: {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
  announceCompletion?: typeof runSubagentAnnounceFlow;
}): AnyAgentTool {
  return {
    label: "Workers",
    name: "workers_dispatch",
    description:
      "Dispatch work to a named worker agent by agentId. Reuses a stable persistent worker session when available and creates it on first use.",
    parameters: WorkersDispatchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? loadConfig();
      const gatewayCall = opts?.callGateway ?? callGateway;
      const announceCompletion = opts?.announceCompletion ?? runSubagentAnnounceFlow;
      const requester = resolveWorkerRequesterContext({
        cfg,
        agentSessionKey: opts?.agentSessionKey,
        requesterAgentIdOverride: opts?.requesterAgentIdOverride,
      });
      const agentId = normalizeAgentId(readStringParam(params, "agentId", { required: true }));
      const task = readStringParam(params, "task", { required: true });
      const wait = params.wait === true;
      const interruptRunning = params.interruptRunning === true;
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 30;
      const announceTimeoutSeconds = resolveWorkerAnnounceTimeoutSeconds({
        cfg,
        requestedTimeoutSeconds: timeoutSeconds,
      });
      const maxSpawnDepth =
        cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
      const callerDepth = getSubagentDepthFromSessionStore(requester.requesterInternalKey, {
        cfg,
      });
      if (callerDepth >= maxSpawnDepth) {
        return jsonResult({
          status: "forbidden",
          error: `workers_dispatch is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
        });
      }

      const directory = buildWorkerDirectory({
        cfg,
        requesterAgentId: requester.requesterAgentId,
      });
      const targetWorker = directory.workers.find((entry) => entry.id === agentId);
      if (!targetWorker) {
        const blockedWorker = directory.blocked.find((entry) => entry.id === agentId);
        if (blockedWorker) {
          return jsonResult({
            status: "forbidden",
            error: blockedWorker.reasons
              .map((reason) => describeWorkerAccessReason(reason))
              .join("; "),
            agentId,
            availableWorkers: directory.workers.map((entry) => entry.id),
          });
        }
        return jsonResult({
          status: "error",
          error: `Unknown or unroutable worker agent: ${agentId}`,
          availableWorkers: directory.workers.map((entry) => entry.id),
        });
      }

      const label = buildWorkerSessionLabel(agentId);
      let workerSession = await findExistingWorkerSession({
        callGateway: gatewayCall,
        agentId,
        requesterInternalKey: requester.requesterInternalKey,
        label,
      });
      let created = false;
      let sessionKey = workerSession.sessionKey;
      if (!sessionKey) {
        try {
          sessionKey = await createWorkerSession({
            callGateway: gatewayCall,
            cfg,
            agentId,
            label,
            requesterInternalKey: requester.requesterInternalKey,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return jsonResult({
            status: "error",
            error,
            agentId,
            label,
          });
        }
        created = true;
        workerSession = {
          sessionKey,
          duplicateCount: workerSession.duplicateCount,
        };
      }

      if (!sessionKey) {
        return jsonResult({
          status: "error",
          error: `Failed to resolve worker session for ${agentId}`,
          agentId,
          label,
        });
      }

      const sendMethod = interruptRunning ? "sessions.steer" : "sessions.send";
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;
      try {
        const sendResult = await gatewayCall<{ runId?: string }>({
          method: sendMethod,
          params: {
            key: sessionKey,
            message: buildDispatchMessage(task),
            idempotencyKey,
          },
          timeoutMs: 10_000,
        });
        if (typeof sendResult?.runId === "string" && sendResult.runId.trim()) {
          runId = sendResult.runId.trim();
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: "error",
          error,
          agentId,
          label,
          sessionKey,
          created,
        });
      }

      if (!wait || timeoutSeconds === 0) {
        scheduleWorkerCompletionAnnounce({
          announceCompletion,
          requesterSessionKey: requester.requesterInternalKey,
          runId,
          sessionKey,
          task,
          timeoutSeconds: announceTimeoutSeconds,
        });
        return jsonResult({
          status: "accepted",
          agentId,
          label,
          sessionKey,
          created,
          runId,
          note: WORKER_DISPATCH_ACCEPTED_NOTE,
          duplicateSessions:
            workerSession.duplicateCount > 1 ? workerSession.duplicateCount : undefined,
          dispatchMode: interruptRunning ? "steer" : "send",
        });
      }

      const waited = await waitForWorkerReply({
        callGateway: gatewayCall,
        runId,
        sessionKey,
        timeoutSeconds,
      });
      if (waited.status !== "ok") {
        return jsonResult({
          status: waited.status,
          error: waited.error,
          agentId,
          label,
          sessionKey,
          created,
          runId,
          duplicateSessions:
            workerSession.duplicateCount > 1 ? workerSession.duplicateCount : undefined,
          dispatchMode: interruptRunning ? "steer" : "send",
        });
      }

      return jsonResult({
        status: "ok",
        agentId,
        label,
        sessionKey,
        created,
        runId,
        reply: waited.reply,
        duplicateSessions:
          workerSession.duplicateCount > 1 ? workerSession.duplicateCount : undefined,
        dispatchMode: interruptRunning ? "steer" : "send",
      });
    },
  };
}
