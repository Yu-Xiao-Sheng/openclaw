import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  buildWorkerDirectory,
  describeWorkerAccessReason,
  resolveWorkerRequesterContext,
} from "../worker-directory.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const WorkersListToolSchema = Type.Object({});

export function createWorkersListTool(opts?: {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Workers",
    name: "workers_list",
    description:
      "List named worker agents routable from this session, with capability summaries derived from their current config and IDENTITY.md.",
    parameters: WorkersListToolSchema,
    execute: async () => {
      const cfg = opts?.config ?? loadConfig();
      const requester = resolveWorkerRequesterContext({
        cfg,
        agentSessionKey: opts?.agentSessionKey,
        requesterAgentIdOverride: opts?.requesterAgentIdOverride,
      });
      const directory = buildWorkerDirectory({
        cfg,
        requesterAgentId: requester.requesterAgentId,
      });

      return jsonResult({
        requester: directory.requester,
        workers: directory.workers,
        blocked: directory.blocked.map((entry) => ({
          ...entry,
          reasonText: entry.reasons.map((reason) => describeWorkerAccessReason(reason)),
        })),
      });
    },
  };
}
