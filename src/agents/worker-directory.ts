import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  listAgentEntries,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { parseIdentityMarkdown, type AgentIdentityFile } from "./identity-file.js";
import { createAgentToAgentPolicy } from "./tools/sessions-access.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";
import { DEFAULT_IDENTITY_FILENAME } from "./workspace.js";

const IDENTITY_METADATA_FIELDS = new Set(["name", "emoji", "theme", "creature", "vibe", "avatar"]);

export type WorkerAccessReason =
  | "subagent_allowlist_denied"
  | "agent_to_agent_disabled"
  | "agent_to_agent_denied";

export type WorkerRequesterContext = {
  mainKey: string;
  alias: string;
  requesterInternalKey: string;
  requesterAgentId: string;
};

export type WorkerDirectoryIdentity = Pick<
  AgentIdentityFile,
  "name" | "emoji" | "theme" | "creature" | "vibe" | "avatar"
>;

export type WorkerDirectoryEntry = {
  id: string;
  label: string;
  name?: string;
  displayName: string;
  workspace: string;
  model?: string;
  identity?: WorkerDirectoryIdentity;
  capabilitySummary?: string;
};

export type BlockedWorkerDirectoryEntry = WorkerDirectoryEntry & {
  reasons: WorkerAccessReason[];
};

export type WorkerDirectory = {
  requester: string;
  allowAny: boolean;
  workers: WorkerDirectoryEntry[];
  blocked: BlockedWorkerDirectoryEntry[];
};

function readIdentityNarrative(identityPath: string): string | undefined {
  let content = "";
  try {
    content = fs.readFileSync(identityPath, "utf-8");
  } catch {
    return undefined;
  }

  const collected: string[] = [];
  let inCodeFence = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
      continue;
    }

    const stripped = trimmed.replace(/^[*-]\s*/, "").trim();
    if (!stripped) {
      continue;
    }

    const colonIndex = stripped.indexOf(":");
    if (colonIndex > 0) {
      const label = stripped.slice(0, colonIndex).replace(/[*_]/g, "").trim().toLowerCase();
      if (IDENTITY_METADATA_FIELDS.has(label)) {
        continue;
      }
    }

    const normalized = stripped
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[`*_>#]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) {
      continue;
    }
    collected.push(normalized);
    if (collected.join(" ").length >= 220) {
      break;
    }
  }

  const joined = collected.join(" ").trim();
  if (!joined) {
    return undefined;
  }
  return joined.length > 220 ? `${joined.slice(0, 217).trimEnd()}...` : joined;
}

function pushUnique(parts: string[], value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return;
  }
  if (!parts.some((part) => part.toLowerCase() === trimmed.toLowerCase())) {
    parts.push(trimmed);
  }
}

function buildCapabilitySummary(params: {
  agentId: string;
  name?: string;
  identity?: WorkerDirectoryIdentity;
  identityNarrative?: string;
}) {
  const parts: string[] = [];
  pushUnique(parts, params.name);
  pushUnique(parts, params.identity?.name);
  if (params.identity?.vibe) {
    pushUnique(parts, `vibe: ${params.identity.vibe}`);
  }
  if (params.identity?.theme) {
    pushUnique(parts, `theme: ${params.identity.theme}`);
  }
  if (params.identity?.creature) {
    pushUnique(parts, `motif: ${params.identity.creature}`);
  }
  pushUnique(parts, params.identityNarrative);

  const summary = parts.join(". ").trim();
  if (summary) {
    return summary;
  }
  return `Named worker session for ${params.agentId}.`;
}

function resolveWorkerAccessReasons(params: {
  a2aPolicy: ReturnType<typeof createAgentToAgentPolicy>;
  requesterAgentId: string;
  targetAgentId: string;
  allowAny: boolean;
  allowSet: Set<string>;
}): WorkerAccessReason[] {
  const reasons: WorkerAccessReason[] = [];
  if (!params.allowAny && !params.allowSet.has(params.targetAgentId)) {
    reasons.push("subagent_allowlist_denied");
  }
  if (!params.a2aPolicy.enabled) {
    reasons.push("agent_to_agent_disabled");
  } else if (!params.a2aPolicy.isAllowed(params.requesterAgentId, params.targetAgentId)) {
    reasons.push("agent_to_agent_denied");
  }
  return reasons;
}

export function describeWorkerAccessReason(reason: WorkerAccessReason): string {
  if (reason === "subagent_allowlist_denied") {
    return "not permitted by requester subagents.allowAgents";
  }
  if (reason === "agent_to_agent_disabled") {
    return "tools.agentToAgent.enabled is false";
  }
  return "denied by tools.agentToAgent.allow";
}

export function buildWorkerSessionLabel(agentId: string): string {
  return `worker:${normalizeAgentId(agentId)}`;
}

export function resolveWorkerRequesterContext(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
}): WorkerRequesterContext {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const requesterInternalKey =
    typeof params.agentSessionKey === "string" && params.agentSessionKey.trim()
      ? resolveInternalSessionKey({
          key: params.agentSessionKey,
          alias,
          mainKey,
        })
      : alias;
  const requesterAgentId = normalizeAgentId(
    params.requesterAgentIdOverride ??
      parseAgentSessionKey(requesterInternalKey)?.agentId ??
      DEFAULT_AGENT_ID,
  );
  return {
    mainKey,
    alias,
    requesterInternalKey,
    requesterAgentId,
  };
}

export function buildWorkerDirectory(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
  includeRequester?: boolean;
}): WorkerDirectory {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const allowAgents =
    listAgentEntries(params.cfg).find((entry) => normalizeAgentId(entry.id) === requesterAgentId)
      ?.subagents?.allowAgents ?? [];
  const allowAny = allowAgents.some((value) => value.trim() === "*");
  const allowSet = new Set(
    allowAgents
      .map((value) => value.trim())
      .filter((value) => value && value !== "*")
      .map((value) => normalizeAgentId(value)),
  );
  const a2aPolicy = createAgentToAgentPolicy(params.cfg);

  const workers: WorkerDirectoryEntry[] = [];
  const blocked: BlockedWorkerDirectoryEntry[] = [];
  for (const entry of listAgentEntries(params.cfg)) {
    const id = normalizeAgentId(entry.id);
    if (!params.includeRequester && id === requesterAgentId) {
      continue;
    }

    const workspace = resolveAgentWorkspaceDir(params.cfg, id);
    const identityPath = path.join(workspace, DEFAULT_IDENTITY_FILENAME);
    const identityContent = fs.existsSync(identityPath)
      ? fs.readFileSync(identityPath, "utf-8")
      : undefined;
    const parsedIdentity = identityContent
      ? (parseIdentityMarkdown(identityContent) as WorkerDirectoryIdentity)
      : undefined;
    const identity =
      parsedIdentity &&
      Object.values(parsedIdentity).some((value) => typeof value === "string" && value.trim())
        ? parsedIdentity
        : undefined;
    const identityNarrative = readIdentityNarrative(identityPath);
    const name =
      typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
    const displayName = identity?.name?.trim() || name || id;
    const workerEntry: WorkerDirectoryEntry = {
      id,
      label: buildWorkerSessionLabel(id),
      name,
      displayName,
      workspace,
      model: resolveAgentEffectiveModelPrimary(params.cfg, id),
      identity,
      capabilitySummary: buildCapabilitySummary({
        agentId: id,
        name,
        identity,
        identityNarrative,
      }),
    };

    if (id === requesterAgentId) {
      workers.push(workerEntry);
      continue;
    }

    const reasons = resolveWorkerAccessReasons({
      a2aPolicy,
      requesterAgentId,
      targetAgentId: id,
      allowAny,
      allowSet,
    });
    if (reasons.length === 0) {
      workers.push(workerEntry);
      continue;
    }
    blocked.push({
      ...workerEntry,
      reasons,
    });
  }

  return {
    requester: requesterAgentId,
    allowAny,
    workers,
    blocked,
  };
}
