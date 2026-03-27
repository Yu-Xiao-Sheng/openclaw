/**
 * Workers Registry - 追踪 workers_dispatch 创建的worker
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WorkerRecord {
  sessionKey: string;
  runId: string;
  agentId: string;
  requesterSessionKey: string;
  task: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "timeout" | "error";
  error?: string;
}

const REGISTRY_DIR = path.join(os.homedir(), ".openclaw");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "workers-registry.jsonl");

function ensureRegistryFile(): void {
  if (!fs.existsSync(REGISTRY_DIR)) {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  }
  if (!fs.existsSync(REGISTRY_FILE)) {
    fs.writeFileSync(REGISTRY_FILE, "", "utf-8");
  }
}

export function registerWorker(record: WorkerRecord): void {
  ensureRegistryFile();
  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(REGISTRY_FILE, line, "utf-8");
}

export function updateWorkerStatus(
  sessionKey: string,
  runId: string,
  updates: Partial<WorkerRecord>,
): void {
  ensureRegistryFile();
  const lines = fs.readFileSync(REGISTRY_FILE, "utf-8").trim().split("\n").filter(Boolean);
  const updated: string[] = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as WorkerRecord;
      if (record.sessionKey === sessionKey && record.runId === runId) {
        Object.assign(record, updates);
      }
      updated.push(JSON.stringify(record));
    } catch {
      // 跳过无效行
    }
  }

  fs.writeFileSync(REGISTRY_FILE, updated.join("\n") + "\n", "utf-8");
}

export function listWorkers(params?: {
  requesterSessionKey?: string;
  recentMinutes?: number;
  status?: WorkerRecord["status"];
}): WorkerRecord[] {
  ensureRegistryFile();
  const lines = fs.readFileSync(REGISTRY_FILE, "utf-8").trim().split("\n").filter(Boolean);
  const records: WorkerRecord[] = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as WorkerRecord;
      records.push(record);
    } catch {
      // 跳过无效行
    }
  }

  // 过滤
  let filtered = records;

  if (params?.requesterSessionKey) {
    filtered = filtered.filter((r) => r.requesterSessionKey === params.requesterSessionKey);
  }

  if (params?.status) {
    filtered = filtered.filter((r) => r.status === params.status);
  }

  if (params?.recentMinutes) {
    const cutoff = Date.now() - params.recentMinutes * 60 * 1000;
    filtered = filtered.filter((r) => r.startedAt >= cutoff);
  }

  // 按开始时间倒序
  filtered.sort((a, b) => b.startedAt - a.startedAt);

  return filtered;
}

export function findWorker(sessionKey: string, runId?: string): WorkerRecord | undefined {
  const workers = listWorkers();
  return workers.find((w) => {
    if (runId) {
      return w.sessionKey === sessionKey && w.runId === runId;
    }
    return w.sessionKey === sessionKey;
  });
}

export function removeWorker(sessionKey: string, runId?: string): number {
  ensureRegistryFile();
  const lines = fs.readFileSync(REGISTRY_FILE, "utf-8").trim().split("\n").filter(Boolean);
  const remaining: string[] = [];
  let removed = 0;

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as WorkerRecord;
      const shouldRemove = runId
        ? record.sessionKey === sessionKey && record.runId === runId
        : record.sessionKey === sessionKey;

      if (shouldRemove) {
        removed++;
      } else {
        remaining.push(JSON.stringify(record));
      }
    } catch {
      // 跳过无效行
    }
  }

  fs.writeFileSync(
    REGISTRY_FILE,
    remaining.join("\n") + (remaining.length > 0 ? "\n" : ""),
    "utf-8",
  );
  return removed;
}
