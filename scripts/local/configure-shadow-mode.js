#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const home = process.env.HOME || "/home/yuxs";
const stateDir = path.join(home, ".openclaw");
const configPath = path.join(stateDir, "openclaw.json");
const manifestBaseUrl = "http://0.0.0.0:2099/v1";
const routingModel = "manifest/auto";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

const desiredAgents = [
  {
    id: "coordinator",
    workspace: path.join(stateDir, "workspace-coordinator"),
  },
  {
    id: "pm",
    workspace: path.join(stateDir, "workspace-pm"),
  },
  {
    id: "frontend",
    workspace: path.join(stateDir, "workspace-frontend"),
  },
  {
    id: "backend",
    workspace: path.join(stateDir, "workspace-backend"),
  },
  {
    id: "qa",
    workspace: path.join(stateDir, "workspace-qa"),
  },
];
const desiredAgentIds = new Set(desiredAgents.map((agent) => agent.id));
const retiredAgentIds = new Set(["main", "codex"]);
const workerIds = desiredAgents
  .filter((agent) => agent.id !== "coordinator")
  .map((agent) => agent.id);
const workspaceIdentityPaths = {
  coordinator: path.join(stateDir, "workspace-coordinator", "IDENTITY.md"),
  pm: path.join(stateDir, "workspace-pm", "IDENTITY.md"),
  frontend: path.join(stateDir, "workspace-frontend", "IDENTITY.md"),
  backend: path.join(stateDir, "workspace-backend", "IDENTITY.md"),
  qa: path.join(stateDir, "workspace-qa", "IDENTITY.md"),
};

const coordinatorBlock = [
  "## 影子口径铁律",
  "",
  "- 你是唯一对外入口与出口。",
  "- 所有来自用户 channel（如 feishu / webchat）的任务，必须先由你接住，再决定是否分派给诸司。",
  "- 其它 agent 只能向你回传内部结果、草稿、实现或风险，不得绕过你直接向用户 channel 做最终汇报。",
  "- 需要协作时，优先使用 sessions_spawn、sessions_send、subagents 等内部手段组织分工；最终结论必须由你整合后对外输出。",
  "- 你对外发言时，先给结论，再给理由，再给下一步；不要把 worker 的原始草稿原样甩给公子。",
].join("\n");

const workerBlock = [
  "## 影子调度铁律",
  "",
  "- 你不是用户入口，也不是最终对外汇报口。",
  "- 你的默认上游是 coordinator（影子）；你的输出应写成供影子汇总的内部报告、建议、实现结果、测试结果或风险清单。",
  "- 除非影子明确要求你直接执行外发动作，否则不要主动向 feishu、webchat 等用户 channel 发送最终回复。",
  "- 如果你在用户会话里被直接点开或直接收到用户指令，不要展开多轮对外答复；先用一句话引导用户回到影子，再停止继续主导对话。",
].join("\n");

function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing file: ${filePath}`);
  }
}

function backupFile(filePath) {
  const backupPath = `${filePath}.bak.${timestamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function writeIfChanged(filePath, nextContent, summary) {
  const existed = fs.existsSync(filePath);
  const current = existed ? fs.readFileSync(filePath, "utf8") : "";
  if (current === nextContent) {
    return { changed: false, backupPath: null, summary };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const backupPath = existed ? backupFile(filePath) : null;
  fs.writeFileSync(filePath, nextContent, "utf8");
  return { changed: true, backupPath, summary };
}

function upsertManagedBlock(text, tag, body) {
  const begin = `<!-- ${tag}:BEGIN -->`;
  const end = `<!-- ${tag}:END -->`;
  const block = `${begin}\n${body}\n${end}`;
  if (text.includes(begin) && text.includes(end)) {
    return text.replace(new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`), block);
  }
  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  return `${normalized}\n${block}\n`;
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBindings(config) {
  const configuredChannels = new Set(
    Object.keys(config.channels || {}).filter((channel) => {
      const value = config.channels?.[channel];
      return value && typeof value === "object" && value.enabled !== false;
    }),
  );
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];
  const kept = bindings.filter((binding) => {
    const channel = binding?.match?.channel;
    if (!channel || !configuredChannels.has(channel)) {
      return true;
    }
    return binding?.agentId === "coordinator";
  });
  const nextBinding = {
    agentId: "coordinator",
    match: {
      channel: "feishu",
      accountId: "main",
    },
  };
  const alreadyPresent = kept.some(
    (binding) =>
      binding?.agentId === nextBinding.agentId &&
      binding?.match?.channel === nextBinding.match.channel &&
      binding?.match?.accountId === nextBinding.match.accountId,
  );
  if (!alreadyPresent) {
    kept.unshift(nextBinding);
  }
  return kept;
}

function main() {
  ensureFile(configPath);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  config.models = config.models || {};
  config.models.providers = config.models.providers || {};
  config.models.providers.manifest = config.models.providers.manifest || {};
  config.models.providers.manifest.baseUrl = manifestBaseUrl;

  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = config.agents.defaults.model || {};
  config.agents.defaults.model.primary = routingModel;
  config.tools = config.tools || {};
  config.tools.sessions = config.tools.sessions || {};
  config.tools.sessions.visibility = "all";
  config.tools.agentToAgent = config.tools.agentToAgent || {};
  config.tools.agentToAgent.enabled = true;

  const existingList = Array.isArray(config.agents.list) ? config.agents.list : [];
  const existingById = new Map(
    existingList
      .filter((agent) => agent && typeof agent === "object" && typeof agent.id === "string")
      .map((agent) => [agent.id, agent]),
  );
  const keptExtras = existingList
    .filter(
      (agent) =>
        agent &&
        typeof agent === "object" &&
        typeof agent.id === "string" &&
        !desiredAgentIds.has(agent.id) &&
        !retiredAgentIds.has(agent.id),
    )
    .map((agent) => ({
      ...agent,
      default: false,
    }));
  config.agents.list = [
    ...desiredAgents.map((agent) => {
      const existing = existingById.get(agent.id);
      return {
        ...(existing && typeof existing === "object" ? existing : {}),
        ...agent,
        model: routingModel,
        default: agent.id === "coordinator",
      };
    }),
    ...keptExtras,
  ];
  config.bindings = normalizeBindings(config);
  config.meta = config.meta || {};
  config.meta.lastTouchedAt = new Date().toISOString();

  const results = [];
  results.push(
    writeIfChanged(
      configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      "normalized ~/.openclaw/openclaw.json",
    ),
  );

  const coordinatorIdentity = fs.existsSync(workspaceIdentityPaths.coordinator)
    ? fs.readFileSync(workspaceIdentityPaths.coordinator, "utf8")
    : "# coordinator identity\n";
  results.push(
    writeIfChanged(
      workspaceIdentityPaths.coordinator,
      upsertManagedBlock(coordinatorIdentity, "OPENCLAW_SHADOW_COORDINATOR", coordinatorBlock),
      "updated coordinator identity constraints",
    ),
  );

  for (const workerId of workerIds) {
    const workerPath = workspaceIdentityPaths[workerId];
    const content = fs.existsSync(workerPath)
      ? fs.readFileSync(workerPath, "utf8")
      : `# ${workerId} identity\n`;
    results.push(
      writeIfChanged(
        workerPath,
        upsertManagedBlock(
          content,
          `OPENCLAW_SHADOW_WORKER_${workerId.toUpperCase()}`,
          workerBlock,
        ),
        `updated ${workerId} identity constraints`,
      ),
    );
  }

  const changed = results.filter((item) => item.changed);
  process.stdout.write(`${changed.length > 0 ? "changed" : "unchanged"}\n`);
  for (const item of results) {
    process.stdout.write(
      `- ${item.summary}${item.changed ? ` [backup: ${item.backupPath}]` : " [no-op]"}\n`,
    );
  }
}

main();
