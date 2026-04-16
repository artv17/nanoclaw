import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { ASSISTANT_NAME } from '../config.js';
import {
  appendApiJobMessage,
  createApiJob,
  deleteOldApiJobs,
  finalizeApiJob,
  getApiJob,
  getApiMessagesFeed,
  getPendingApiJobs,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const JID_PREFIX = 'api:';

export class ApiChannel implements Channel {
  name = 'api';

  private server: http.Server | null = null;
  private opts: ChannelOpts;
  private apiKey: string;
  private port: number;
  private connected = false;

  // jid → FIFO queue of pending job_ids (rebuilt from DB on connect)
  private pendingByJid = new Map<string, string[]>();
  // jid → model override for the current pending job (e.g. "gemini-2.5-pro")
  private modelByJid = new Map<string, string>();

  constructor(apiKey: string, port: number, opts: ChannelOpts) {
    this.apiKey = apiKey;
    this.port = port;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Fail stale jobs from before restart — do NOT restore them to the live queue.
    // If we restored them, they would sit at the front of pendingByJid and intercept
    // responses meant for new jobs posted after the restart.
    const stale = getPendingApiJobs();
    for (const { jobId } of stale) {
      appendApiJobMessage(jobId, '[Service was restarted before this request could be completed. Please retry.]');
      finalizeApiJob(jobId);
    }
    if (stale.length > 0) {
      logger.info(
        { count: stale.length },
        'API channel: failed stale jobs from previous run',
      );
    }

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '0.0.0.0', () => {
        logger.info({ port: this.port }, 'API channel listening');
        resolve();
      });
      this.server!.on('error', reject);
    });
    this.connected = true;

    // Clean up old resolved jobs (keep last 24h)
    deleteOldApiJobs(24);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const queue = this.pendingByJid.get(jid);
    if (!queue || queue.length === 0) {
      logger.warn(
        { jid },
        'API channel: sendMessage called but no pending job',
      );
      return;
    }
    const jobId = queue[0]; // peek — don't pop until query completes
    appendApiJobMessage(jobId, text);
    logger.info({ jid, jobId }, 'API channel: message appended to job');
  }

  onQueryComplete(jid: string): void {
    const queue = this.pendingByJid.get(jid);
    if (!queue || queue.length === 0) return;
    const jobId = queue.shift()!;
    if (queue.length === 0) {
      this.pendingByJid.delete(jid);
      this.modelByJid.delete(jid);
    }
    finalizeApiJob(jobId);
    logger.info({ jid, jobId }, 'API channel: job finalized');
  }

  modelOverrideForJid(jid: string): string | undefined {
    return this.modelByJid.get(jid);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  private folderFor(userId: string, sessionId?: string): string {
    const sanitize = (s: string, max: number) => {
      let out = s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, max);
      if (!/^[A-Za-z0-9]/.test(out)) out = 'u' + out.slice(0, max - 1);
      return out;
    };
    const userPart = sanitize(userId, sessionId ? 30 : 55);
    return sessionId
      ? `api_${userPart}_${sanitize(sessionId, 25)}`
      : `api_${userPart}`;
  }

  private jidFor(userId: string, sessionId?: string): string {
    return sessionId
      ? `${JID_PREFIX}${userId}:${sessionId}`
      : `${JID_PREFIX}${userId}`;
  }

  private persistToken(folder: string, token: string): void {
    const groupDir = path.join(path.resolve(process.cwd(), 'groups'), folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'mcp-token.txt'), token, 'utf-8');
  }

  private ensureUserGroup(userId: string, jid: string, folder: string): void {
    const now = new Date().toISOString();
    // Always ensure the chat metadata record exists (required by FK on messages table)
    this.opts.onChatMetadata(jid, now, userId, 'api', false);

    const groups = this.opts.registeredGroups();
    if (groups[jid]) return;
    if (!this.opts.registerGroup) {
      logger.warn({ jid }, 'API channel: registerGroup callback not available');
      return;
    }
    const group: RegisteredGroup = {
      name: userId,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: now,
      requiresTrigger: false,
      isMain: false,
    };
    this.opts.registerGroup(jid, group);
  }

  private authenticate(req: http.IncomingMessage): boolean {
    return req.headers['x-api-key'] === this.apiKey;
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (!this.authenticate(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const url = new URL(req.url!, `http://localhost:${this.port}`);

    if (req.method === 'POST' && url.pathname === '/api/message') {
      this.handlePostMessage(req, res);
    } else if (
      req.method === 'GET' &&
      url.pathname.startsWith('/api/message/')
    ) {
      const jobId = url.pathname.slice('/api/message/'.length);
      this.handleGetMessage(jobId, res);
    } else if (req.method === 'GET' && url.pathname === '/api/messages') {
      this.handleGetMessagesFeed(url, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private handlePostMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as {
          user_id?: string;
          session_id?: string;
          message?: string;
          token?: string;
          llm_model?: string;
        };
        const { user_id, session_id, message, token, llm_model } = parsed;

        if (!user_id || typeof user_id !== 'string' || !user_id.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'user_id is required' }));
          return;
        }
        if (
          session_id !== undefined &&
          (typeof session_id !== 'string' || !session_id.trim())
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: 'session_id must be a non-empty string' }),
          );
          return;
        }
        if (!message || typeof message !== 'string' || !message.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message is required' }));
          return;
        }
        if (!token || typeof token !== 'string' || !token.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'token is required' }));
          return;
        }

        const sessionIdClean = session_id?.trim();
        const jid = this.jidFor(user_id, sessionIdClean);
        const folder = this.folderFor(user_id, sessionIdClean);
        const jobId = crypto.randomUUID();
        const now = new Date().toISOString();

        // Extract tenant claim from JWT token (decode payload, no verification needed)
        let tenantId: string | undefined;
        try {
          const payload = JSON.parse(
            Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'),
          );
          tenantId = payload.tenant ?? undefined;
        } catch {
          // token not a JWT or no tenant claim — leave undefined
        }

        // Persist job to DB before enqueuing (survives restarts)
        createApiJob(jobId, jid, now, tenantId);

        if (!this.pendingByJid.has(jid)) this.pendingByJid.set(jid, []);
        this.pendingByJid.get(jid)!.push(jobId);
        if (llm_model) this.modelByJid.set(jid, llm_model);

        this.ensureUserGroup(user_id, jid, folder);
        this.persistToken(folder, token);

        const msg: NewMessage = {
          id: jobId,
          chat_jid: jid,
          sender: jid,
          sender_name: user_id,
          content: message,
          timestamp: now,
          is_from_me: false,
          is_bot_message: false,
        };
        this.opts.onMessage(jid, msg);

        // Trigger immediate message check (avoids poll-loop race for new JIDs)
        this.opts.enqueueCheck?.(jid);

        logger.info({ jid, jobId }, 'API channel: message received');

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ job_id: jobId }));
      } catch (err) {
        logger.error({ err }, 'API channel: error parsing request body');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
  }

  private handleGetMessagesFeed(url: URL, res: http.ServerResponse): void {
    const since = url.searchParams.get('since') || new Date(0).toISOString();
    const sessionId = url.searchParams.get('session_id') || undefined;

    const items = getApiMessagesFeed(since, sessionId);

    const messages = items.flatMap((item) =>
      item.messages.map((content, idx) => ({
        message_id: `${item.jobId}_${idx}`,
        job_id: item.jobId,
        tenant_id: item.tenantId,
        user_id: item.userId,
        session_id: item.sessionId,
        message_index: idx,
        content,
        status: item.status,
        updated_at: item.updatedAt,
      })),
    );

    const nextSince =
      items.length > 0
        ? items[items.length - 1].updatedAt
        : since;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages, next_since: nextSince }));
  }

  private handleGetMessage(jobId: string, res: http.ServerResponse): void {
    const job = getApiJob(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    const rawMessages = job.messages ?? [];
    const messages = rawMessages.map((content, idx) => ({
      message_id: `${jobId}_${idx}`,
      message_index: idx,
      content,
    }));
    const response = messages.length > 0 ? messages[messages.length - 1] : null;
    if (job.status === 'done') {
      res.end(JSON.stringify({ status: 'done', messages, response }));
    } else if (messages.length > 0) {
      res.end(JSON.stringify({ status: 'in_progress', messages, response }));
    } else {
      res.end(JSON.stringify({ status: 'pending' }));
    }
  }
}

registerChannel('api', (opts) => {
  const env = readEnvFile(['API_KEY', 'API_PORT']);
  if (!env.API_KEY) return null;
  const port = parseInt(env.API_PORT || '3002', 10);
  return new ApiChannel(env.API_KEY, port, opts);
});
