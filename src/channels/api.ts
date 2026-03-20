import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const JID_PREFIX = 'api:';

interface Job {
  jid: string;
  status: 'pending' | 'done';
  response?: string;
}

export class ApiChannel implements Channel {
  name = 'api';

  private server: http.Server | null = null;
  private opts: ChannelOpts;
  private apiKey: string;
  private port: number;
  private connected = false;

  // job_id → Job
  private jobs = new Map<string, Job>();
  // jid → FIFO queue of pending job_ids
  private pendingByJid = new Map<string, string[]>();

  constructor(apiKey: string, port: number, opts: ChannelOpts) {
    this.apiKey = apiKey;
    this.port = port;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '0.0.0.0', () => {
        logger.info({ port: this.port }, 'API channel listening');
        resolve();
      });
      this.server!.on('error', reject);
    });
    this.connected = true;
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
    const jobId = queue.shift()!;
    if (queue.length === 0) this.pendingByJid.delete(jid);

    const job = this.jobs.get(jobId);
    if (job) {
      job.status = 'done';
      job.response = text;
    }
    logger.info({ jid, jobId }, 'API channel: job resolved');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  private folderForUserId(userId: string): string {
    // Sanitize user_id to a valid group folder name
    let sanitized = userId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 55);
    if (!/^[A-Za-z0-9]/.test(sanitized))
      sanitized = 'u' + sanitized.slice(0, 54);
    return `api_${sanitized}`;
  }

  private persistToken(userId: string, token: string): void {
    const folder = this.folderForUserId(userId);
    const groupDir = path.join(path.resolve(process.cwd(), 'groups'), folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'mcp-token.txt'), token, 'utf-8');
  }

  private ensureUserGroup(userId: string, jid: string): void {
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
      folder: this.folderForUserId(userId),
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
          message?: string;
          token?: string;
        };
        const { user_id, message, token } = parsed;

        if (!user_id || typeof user_id !== 'string' || !user_id.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'user_id is required' }));
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

        const jid = `${JID_PREFIX}${user_id}`;
        const jobId = crypto.randomUUID();
        const now = new Date().toISOString();

        this.jobs.set(jobId, { jid, status: 'pending' });

        if (!this.pendingByJid.has(jid)) this.pendingByJid.set(jid, []);
        this.pendingByJid.get(jid)!.push(jobId);

        this.ensureUserGroup(user_id, jid);
        this.persistToken(user_id, token);

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

  private handleGetMessage(jobId: string, res: http.ServerResponse): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (job.status === 'done') {
      res.end(JSON.stringify({ status: 'done', response: job.response }));
      this.jobs.delete(jobId);
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
