/**
 * 重启待发送消息缓存
 * 在 Gateway 重启期间，WebSocket会话可能断开，- agent回复在重启过程中产生
- 重启后回复丢失
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PENDING_MESSAGES_FILE = path.join(os.homedir(), ".openclaw", "restart-pending-messages.json");
const RESTART_FLAG_FILE = path.join(os.homedir(), ".openclaw", "gateway-restarting.flag");
const MAX_PENDING_AGE_MS = 300000; // 5 minutes

/**
 * 设置 Gateway 正在重启标志
 */
export function setRestartingFlag(): void {
  const filePath = RESTART_FLAG_FILE;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, Date.now().toString(), "utf-8");
}

/**
 * 清除 Gateway 正在重启标志
 */
export function clearRestartingFlag(): void {
  const filePath = RESTART_FLAG_FILE;
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

/**
 * 检查 Gateway 是否正在重启
 */
export function isGatewayRestarting(): boolean {
  const filePath = RESTART_FLAG_FILE;
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    const startTime = parseInt(fs.readFileSync(filePath, "utf-8"), 10);
    // 如果标志超过 60 秒，认为重启已完成，清除标志
    if (Date.now() - startTime > 60000) {
      clearRestartingFlag();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface PendingMessage {
  sessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
  message: string;
  timestamp: number;
}

/**
 * 缓存一条待发送消息
 */
export function cachePendingMessage(msg: Omit<PendingMessage, "timestamp">): void {
  const filePath = PENDING_MESSAGES_FILE;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let data: PendingMessage[] = [];
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const now = Date.now();
        data = parsed.filter((m) => now - m.timestamp < MAX_PENDING_AGE_MS);
      }
    } catch {
      // ignore
    }
  }

  data.push({ ...msg, timestamp: Date.now() });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * 获取所有有效的待发送消息
 */
export function getPendingMessages(): PendingMessage[] {
  const filePath = PENDING_MESSAGES_FILE;
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      return [];
    }
    const now = Date.now();
    return data
      .filter((m) => now - m.timestamp < MAX_PENDING_AGE_MS)
      .toSorted((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

/**
 * 清除所有待发送消息
 */
export function clearPendingMessages(): void {
  const filePath = PENDING_MESSAGES_FILE;
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

/**
 * 消费所有待发送消息（获取后清除）
 */
export function consumePendingMessages(): PendingMessage[] {
  const messages = getPendingMessages();
  clearPendingMessages();
  return messages;
}
