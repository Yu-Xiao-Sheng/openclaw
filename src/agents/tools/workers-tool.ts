/**
 * workers 管理工具
 * list / kill / steer workers_dispatch 创建的worker
 */

import { Type } from "@sinclair/typebox";
import { callGateway } from "../../gateway/call.js";
import {
  listWorkers,
  findWorker,
  updateWorkerStatus,
  type WorkerRecord,
} from "../workers-registry.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";

const WORKER_ACTIONS = ["list", "kill", "steer"] as const;
type WorkerAction = (typeof WORKER_ACTIONS)[number];

const WorkersToolSchema = Type.Object({
  action: Type.Optional(Type.String()),
  target: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  recentMinutes: Type.Optional(Type.Number()),
});

const MAX_RECENT_MINUTES = 1440; // 24 hours
const DEFAULT_RECENT_MINUTES = 60;
const MAX_STEER_MESSAGE_CHARS = 4000;

function formatRuntime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function workerToView(worker: WorkerRecord) {
  return {
    sessionKey: worker.sessionKey,
    runId: worker.runId,
    agentId: worker.agentId,
    status: worker.status,
    startedAt: new Date(worker.startedAt).toISOString(),
    runtimeMs: worker.endedAt ? worker.endedAt - worker.startedAt : Date.now() - worker.startedAt,
    runtime: formatRuntime(
      worker.endedAt ? worker.endedAt - worker.startedAt : Date.now() - worker.startedAt,
    ),
    task: worker.task.length > 100 ? worker.task.slice(0, 100) + "..." : worker.task,
    error: worker.error,
  };
}

export function createWorkersTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Workers",
    name: "workers",
    description:
      "Manage workers created by workers_dispatch. List, kill, or steer running workers. Use this to manage long-running async agent tasks.",
    parameters: WorkersToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "list") as WorkerAction;
      const requesterSessionKey = opts?.agentSessionKey;

      if (action === "list") {
        const recentMinutesRaw = readNumberParam(params, "recentMinutes");
        const recentMinutes = recentMinutesRaw
          ? Math.max(1, Math.min(MAX_RECENT_MINUTES, Math.floor(recentMinutesRaw)))
          : DEFAULT_RECENT_MINUTES;

        const workers = listWorkers({
          requesterSessionKey,
          recentMinutes,
        });

        const active = workers.filter((w) => w.status === "running");
        const recent = workers.filter((w) => w.status !== "running");

        return jsonResult({
          status: "ok",
          action: "list",
          requesterSessionKey,
          total: workers.length,
          activeCount: active.length,
          active: active.map(workerToView),
          recent: recent.slice(0, 20).map(workerToView),
          text:
            active.length > 0
              ? `${active.length} active worker${active.length === 1 ? "" : "s"}`
              : "no active workers",
        });
      }

      if (action === "kill") {
        const target = readStringParam(params, "target", { required: true });

        if (target === "all" || target === "*") {
          const workers = listWorkers({ requesterSessionKey, status: "running" });
          let killed = 0;

          for (const worker of workers) {
            try {
              await callGateway({
                method: "sessions.delete",
                params: {
                  key: worker.sessionKey,
                  deleteTranscript: false,
                  emitLifecycleHooks: true,
                },
                timeoutMs: 10_000,
              });
              updateWorkerStatus(worker.sessionKey, worker.runId, {
                status: "error",
                error: "killed by user",
                endedAt: Date.now(),
              });
              killed++;
            } catch {
              // 继续尝试其他
            }
          }

          return jsonResult({
            status: "ok",
            action: "kill",
            target: "all",
            killed,
            text:
              killed > 0
                ? `killed ${killed} worker${killed === 1 ? "" : "s"}`
                : "no active workers to kill",
          });
        }

        // Kill specific worker
        const worker = findWorker(target);
        if (!worker) {
          return jsonResult({
            status: "error",
            action: "kill",
            target,
            error: "Worker not found.",
          });
        }

        try {
          await callGateway({
            method: "sessions.delete",
            params: {
              key: worker.sessionKey,
              deleteTranscript: false,
              emitLifecycleHooks: true,
            },
            timeoutMs: 10_000,
          });

          updateWorkerStatus(worker.sessionKey, worker.runId, {
            status: "error",
            error: "killed by user",
            endedAt: Date.now(),
          });

          return jsonResult({
            status: "ok",
            action: "kill",
            target,
            sessionKey: worker.sessionKey,
            runId: worker.runId,
            agentId: worker.agentId,
            text: `killed worker ${worker.agentId}`,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return jsonResult({
            status: "error",
            action: "kill",
            target,
            error,
          });
        }
      }

      if (action === "steer") {
        const target = readStringParam(params, "target", { required: true });
        const message = readStringParam(params, "message", { required: true });

        if (message.length > MAX_STEER_MESSAGE_CHARS) {
          return jsonResult({
            status: "error",
            action: "steer",
            target,
            error: `Message too long (${message.length} chars, max ${MAX_STEER_MESSAGE_CHARS}).`,
          });
        }

        const worker = findWorker(target);
        if (!worker) {
          return jsonResult({
            status: "error",
            action: "steer",
            target,
            error: "Worker not found.",
          });
        }

        if (worker.status !== "running") {
          return jsonResult({
            status: "done",
            action: "steer",
            target,
            sessionKey: worker.sessionKey,
            text: `Worker ${worker.agentId} is already ${worker.status}.`,
          });
        }

        try {
          await callGateway({
            method: "sessions.steer",
            params: {
              key: worker.sessionKey,
              message,
            },
            timeoutMs: 10_000,
          });

          return jsonResult({
            status: "accepted",
            action: "steer",
            target,
            sessionKey: worker.sessionKey,
            runId: worker.runId,
            agentId: worker.agentId,
            text: `steered worker ${worker.agentId} with new message`,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return jsonResult({
            status: "error",
            action: "steer",
            target,
            error,
          });
        }
      }

      return jsonResult({
        status: "error",
        error: "Unsupported action. Use: list, kill, steer.",
      });
    },
  };
}
