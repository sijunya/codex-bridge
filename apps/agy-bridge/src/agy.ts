import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { BridgeError, type ObjectMap } from './protocol.js';

export interface RpcPeer extends EventEmitter {
  ready: boolean;
  request(method: string, params: ObjectMap, timeout?: number): Promise<any>;
  isTurnActive?(threadId: string): boolean;
  getMappedConversationId?(threadId: string): string | undefined;
}

const AGY_DATA_DIR = join(homedir(), '.gemini', 'antigravity-cli');
const CONVERSATIONS_DB = join(AGY_DATA_DIR, 'conversation_summaries.db');
const BRAIN_DIR = join(AGY_DATA_DIR, 'brain');
const TOKEN_FILE = join(AGY_DATA_DIR, 'antigravity-oauth-token');
const GOLDEN_TOKEN_FILE = join(AGY_DATA_DIR, 'sijunyaya_golden_token.json');

interface CurrentTurn {
  turnId: string;
  clientThreadId: string;
  prompt: string;
  messageItemId: string;
  reasoningItemId: string;
  hasEmittedMessageStart: boolean;
  hasEmittedReasoningStart: boolean;
  hasEmittedReasoningComplete: boolean;
  accumulatedText: string;
}

interface ThreadSession {
  child: ChildProcessWithoutNullStreams;
  rl: any;
  agyConversationId?: string;
  currentTurn?: CurrentTurn;
  lastUsed: number;
  model: string;
  effort: string;
}

function agyBin(): string {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  const local = join(homedir(), '.local', 'bin', 'agy');
  if (existsSync(local)) return local;
  return 'agy';
}

function cleanUserContent(raw: string): string {
  if (!raw) return '';
  const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (match) return match[1].trim();
  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/g, '')
    .trim();
}

export class AgyPeer extends EventEmitter implements RpcPeer {
  ready = false;
  private sessions = new Map<string, ThreadSession>();
  private conversationMap = new Map<string, string>();
  private agyPath: string;

  constructor() {
    super();
    this.agyPath = agyBin();

    // Ensure token is valid on boot and every 60s
    this.ensureValidToken();
    setInterval(() => {
      this.ensureValidToken();
    }, 60_000).unref();

    // Clean up idle sessions after 1 hour of inactivity
    setInterval(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) {
        if (!s.currentTurn && now - s.lastUsed > 3600_000) {
          console.log(`[agy] Reaping idle session for thread ${id}`);
          s.child.kill('SIGTERM');
          this.sessions.delete(id);
        }
      }
    }, 60_000).unref();
  }

  ensureValidToken(): void {
    if (!existsSync(GOLDEN_TOKEN_FILE)) return;

    try {
      let needsRestore = false;
      let reason = '';

      if (!existsSync(TOKEN_FILE)) {
        needsRestore = true;
        reason = 'Token file does not exist';
      } else {
        const raw = readFileSync(TOKEN_FILE, 'utf8');
        try {
          const parsed = JSON.parse(raw);
          let email = '';
          if (parsed.id_token) {
            const parts = parsed.id_token.split('.');
            if (parts.length >= 2) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
              email = payload.email || '';
            }
          }
          if (!email || !email.includes('sijunyaya')) {
            needsRestore = true;
            reason = `Token email is invalid or rogue (${email || 'unknown'})`;
          } else {
            // If current token is valid and newer than golden token, update golden token reference
            if (parsed.token?.expiry && existsSync(GOLDEN_TOKEN_FILE)) {
              try {
                const goldenRaw = readFileSync(GOLDEN_TOKEN_FILE, 'utf8');
                const goldenParsed = JSON.parse(goldenRaw);
                const currentExpiry = new Date(parsed.token.expiry).getTime();
                const goldenExpiry = goldenParsed.token?.expiry ? new Date(goldenParsed.token.expiry).getTime() : 0;
                if (currentExpiry > goldenExpiry && parsed.token.refresh_token) {
                  writeFileSync(GOLDEN_TOKEN_FILE, raw, { mode: 0o600 });
                  console.log(`[agy] Updated golden token with refreshed token (expiry: ${parsed.token.expiry})`);
                }
              } catch { /* ignore golden token update error */ }
            }
          }
        } catch (parseErr) {
          needsRestore = true;
          reason = `Token file corrupted: ${parseErr}`;
        }
      }

      if (needsRestore) {
        console.warn(`[agy] [GUARD] Restoring golden token: ${reason}`);
        copyFileSync(GOLDEN_TOKEN_FILE, TOKEN_FILE);
      }
    } catch (err) {
      console.error('[agy] Error in ensureValidToken:', err);
    }
  }

  isTurnActive(threadId: string): boolean {
    const agyConvId = this.conversationMap.get(threadId);
    const session = this.sessions.get(threadId) || (agyConvId ? this.sessions.get(agyConvId) : undefined);
    return !!(session && session.currentTurn && session.child.exitCode === null);
  }

  getMappedConversationId(threadId: string): string | undefined {
    return this.conversationMap.get(threadId);
  }

  async start(): Promise<void> {
    this.ensureValidToken();
    const version = spawnSync(this.agyPath, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    if (version.status !== 0) {
      throw new BridgeError('AGY_NOT_FOUND', `agy CLI not available at ${this.agyPath}: ${version.stderr?.trim()}`);
    }
    console.log(`[agy] Found: ${version.stdout?.trim()}`);
    this.ready = true;
  }

  async request(method: string, params: ObjectMap, _timeout?: number): Promise<any> {
    switch (method) {
      case 'initialize':
        return { serverInfo: { name: 'agy-bridge', version: '0.1.0' } };
      case 'thread/list':
        return this.listThreads(params);
      case 'thread/start':
        return this.startThread(params);
      case 'thread/read':
        return this.readThread(params);
      case 'thread/resume':
      case 'thread/fork':
        return this.resumeThread(params);
      case 'turn/start':
        return this.startTurn(params);
      case 'turn/interrupt':
        return this.interruptTurn(params);
      case 'turn/steer':
        return this.steerTurn(params);
      case 'thread/name/set':
        return {};
      case 'thread/archive':
      case 'thread/unarchive':
        return {};
      case 'model/list': {
        const modelList = [
          { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High 深度思考)', isDefault: true, model: 'gemini-3.8-flash-high', defaultReasoningEffort: 'high' },
          { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro', isDefault: false, model: 'gemini-3.1-pro-high', defaultReasoningEffort: 'high' },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', isDefault: false, model: 'claude-sonnet-4-6', defaultReasoningEffort: 'high' },
          { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6', isDefault: false, model: 'claude-opus-4-6-thinking', defaultReasoningEffort: 'high' },
          { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low 极速)', isDefault: false, model: 'gemini-3.8-flash-low', defaultReasoningEffort: 'low' },
        ];
        return { data: modelList, models: modelList };
      }
      case 'collaborationMode/list': {
        const modeList = [{ id: 'default', name: 'Default', isDefault: true }];
        return { data: modeList, modes: modeList };
      }
      case 'skills/list': {
        const skillsDir = join(homedir(), '.gemini', 'skills');
        let skillItems: any[] = [];
        if (existsSync(skillsDir)) {
          try {
            const dirs = await readdir(skillsDir);
            skillItems = dirs.map(d => ({ name: d, path: join(skillsDir, d), enabled: true }));
          } catch { /* ignore */ }
        }
        return { data: [{ cwd: homedir(), skills: skillItems }], skills: skillItems };
      }
      case 'mcpServerStatus/list':
        return { data: [], servers: [] };
      case 'configRequirements/read':
        return { requirements: { allowedSandboxModes: ['danger-full-access'], allowedApprovalPolicies: ['never'] } };
      case 'account/read':
        return { account: { email: 'agy-bridge@local' } };
      default:
        throw new BridgeError('METHOD_NOT_ALLOWED', `Method ${method} is not supported by agy-bridge`);
    }
  }

  respond(_id: string | number, _result: unknown): void { /* no-op for agy */ }
  reject(_id: string | number, _message: string): void { /* no-op for agy */ }

  private listThreads(params: ObjectMap): ObjectMap {
    if (!existsSync(CONVERSATIONS_DB)) return { data: [], threads: [], nextCursor: null, hasMore: false };
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(CONVERSATIONS_DB, { open: true });

      let query = 'SELECT * FROM conversation_summaries';
      const conditions: string[] = [];

      // Filter by workspace_uris if cwd provided
      if (params.cwd) {
        const cwdUri = `file://${String(params.cwd)}`;
        conditions.push(`(workspace_uris LIKE '%${cwdUri.replace(/'/g, "''")}%' OR workspace_uris = '' OR workspace_uris IS NULL)`);
      }

      if (params.searchTerm) {
        const term = String(params.searchTerm).replace(/'/g, "''");
        conditions.push(`(title LIKE '%${term}%' OR preview LIKE '%${term}%')`);
      }

      // Filter out empty 0-step conversations if title is empty
      conditions.push(`NOT (step_count = 0 AND (title IS NULL OR title = ''))`);

      if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
      query += ' ORDER BY last_modified_time DESC LIMIT 100';

      const rows = db.prepare(query).all() as any[];
      const threads = rows.map(row => this.rowToThread(row));
      return { data: threads, threads, nextCursor: null, hasMore: false };
    } catch (error) {
      console.error('[agy] Failed to list conversations from sqlite:', error);
      return { data: [], threads: [], nextCursor: null, hasMore: false };
    } finally {
      db?.close();
    }
  }

  private rowToThread(row: any): ObjectMap {
    let cwd = homedir();
    try {
      const uris = JSON.parse(row.workspace_uris || '[]');
      if (uris.length > 0) cwd = uris[0].replace('file://', '');
    } catch { /* ignore */ }

    let createdAt = Math.floor(Date.now() / 1000);
    let updatedAt = Math.floor(Date.now() / 1000);
    if (row.last_user_input_time && !row.last_user_input_time.startsWith('0001')) {
      const t = Date.parse(row.last_user_input_time);
      if (!isNaN(t)) createdAt = Math.floor(t / 1000);
    }
    if (row.last_modified_time && !row.last_modified_time.startsWith('0001')) {
      const t = Date.parse(row.last_modified_time);
      if (!isNaN(t)) updatedAt = Math.floor(t / 1000);
    }

    const title = row.title || row.preview || '会话';

    return {
      id: row.conversation_id,
      name: title,
      preview: row.preview || title,
      status: { type: row.status?.includes('IDLE') || row.status?.includes('COMPLETED') ? 'completed' : 'active' },
      cwd,
      createdAt,
      updatedAt,
      archived: false,
      cliVersion: '1.2.9',
      ephemeral: false,
      modelProvider: 'google',
      projectId: null,
      sessionId: row.conversation_id,
      source: 'cli',
      turns: [],
    };
  }

  private startThread(params: ObjectMap): ObjectMap {
    const threadId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const thread = {
      id: threadId,
      name: '新会话',
      preview: '',
      status: { type: 'completed' },
      cwd: params.cwd || homedir(),
      createdAt: now,
      updatedAt: now,
      archived: false,
      cliVersion: '1.2.9',
      ephemeral: false,
      modelProvider: 'google',
      projectId: null,
      sessionId: threadId,
      source: 'cli',
      turns: [],
    };
    return { thread };
  }

  private async readThread(params: ObjectMap): Promise<ObjectMap> {
    const threadId = params.threadId as string;
    const now = Math.floor(Date.now() / 1000);
    let thread: ObjectMap = {
      id: threadId,
      name: '会话',
      preview: '会话',
      status: { type: 'completed' },
      cwd: homedir(),
      createdAt: now,
      updatedAt: now,
      archived: false,
      cliVersion: '1.2.9',
      ephemeral: false,
      modelProvider: 'google',
      projectId: null,
      sessionId: threadId,
      source: 'cli',
      turns: [],
    };

    // Try to get metadata from conversation_summaries DB
    if (existsSync(CONVERSATIONS_DB)) {
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(CONVERSATIONS_DB, { open: true });
        const row = db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(threadId) as any;
        if (row) thread = this.rowToThread(row);
      } catch { /* ignore */ }
      finally { db?.close(); }
    }

    // If includeTurns is requested, try to parse transcript
    if (params.includeTurns) {
      const turns = await this.loadTranscript(threadId);
      thread.turns = turns;
    }

    return { thread };
  }

  private async loadTranscript(threadId: string): Promise<ObjectMap[]> {
    const transcriptPath = join(BRAIN_DIR, threadId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(transcriptPath)) return [];

    try {
      const content = await readFile(transcriptPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const turns: ObjectMap[] = [];
      let currentTurn: ObjectMap | null = null;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'USER_INPUT' || entry.source === 'USER_EXPLICIT') {
            if (currentTurn) turns.push(currentTurn);
            const turnId = randomUUID();
            const text = cleanUserContent(entry.content || '');
            currentTurn = {
              id: turnId,
              status: 'completed',
              items: [{
                id: randomUUID(),
                type: 'userMessage',
                turnId: turnId,
                content: [{ type: 'text', text }],
                text,
              }],
            };
          } else if (entry.type === 'PLANNER_RESPONSE' || entry.source === 'MODEL') {
            if (currentTurn) {
              if (entry.thinking) {
                currentTurn.items.push({
                  id: randomUUID(),
                  type: 'reasoning',
                  turnId: currentTurn.id,
                  summary: [entry.thinking],
                  text: entry.thinking,
                });
              }
              if (Array.isArray(entry.tool_calls)) {
                for (const tc of entry.tool_calls) {
                  currentTurn.items.push({
                    id: randomUUID(),
                    type: 'commandExecution',
                    turnId: currentTurn.id,
                    command: tc.name || 'tool',
                    aggregatedOutput: JSON.stringify(tc.args ?? ''),
                    status: 'completed',
                  });
                }
              }
              if (entry.content) {
                currentTurn.items.push({
                  id: randomUUID(),
                  type: 'agentMessage',
                  turnId: currentTurn.id,
                  content: [{ type: 'text', text: entry.content }],
                  text: entry.content,
                });
              }
            }
          }
        } catch { /* skip malformed lines */ }
      }
      if (currentTurn) turns.push(currentTurn);
      return turns;
    } catch {
      return [];
    }
  }

  private async resumeThread(params: ObjectMap): Promise<ObjectMap> {
    const threadId = params.threadId as string;
    const res = await this.readThread({ threadId, includeTurns: true });
    return {
      ...res,
      cwd: res.thread?.cwd || homedir(),
      model: 'gemini-3.8-flash-high',
      modelProvider: 'google',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { type: 'dangerFullAccess' },
    };
  }

  private async startTurn(params: ObjectMap): Promise<ObjectMap> {
    this.ensureValidToken();
    const threadId = params.threadId as string;
    const turnId = randomUUID();
    const prompt = this.extractPrompt(params.input);

    if (!prompt) throw new BridgeError('INVALID_PARAMS', 'No text input provided');

    // Default to high quality per user instruction: gemini-3.8-flash-high with effort high
    const rawModel = (params.model as string) || 'gemini-3.8-flash-high';
    const model = rawModel;
    const effort = (params.effort as string) || (model.includes('low') ? 'low' : 'high');

    // Resolve mapped agy conversation ID if already known or existing on disk
    const agyConversationId = this.conversationMap.get(threadId) ?? (existsSync(join(BRAIN_DIR, threadId)) ? threadId : undefined);

    // Check existing persistent session for this thread or mapped conversation ID
    let session = this.sessions.get(threadId);
    if (!session && agyConversationId) {
      session = this.sessions.get(agyConversationId);
    }

    // If an existing session has exited or has mismatched model/effort, clean it up
    if (session && (session.child.exitCode !== null || session.model !== model || session.effort !== effort)) {
      console.log(`[agy] Retiring previous session for thread ${threadId} (exitCode: ${session.child.exitCode}, modelChanged: ${session.model !== model})`);
      this.killProcess(threadId);
      if (agyConversationId) this.killProcess(agyConversationId);
      session = undefined;
    }

    if (session?.currentTurn) {
      console.log(`[agy] Session for thread ${threadId} has previous active turn ${session.currentTurn.turnId}, auto-retiring old turn`);
      this.killProcess(threadId);
      if (agyConversationId) this.killProcess(agyConversationId);
      session = undefined;
    }

    // Emit turn/started notification
    this.emit('notification', {
      method: 'turn/started',
      params: { threadId, turn: { id: turnId } },
    });

    // Emit userMessage item so the user prompt appears in chat immediately
    const userMessageId = randomUUID();
    this.emit('notification', {
      method: 'item/started',
      params: {
        threadId,
        item: {
          id: userMessageId,
          type: 'userMessage',
          turnId,
          content: [{ type: 'text', text: prompt }],
        },
      },
    });
    this.emit('notification', {
      method: 'item/completed',
      params: {
        threadId,
        item: {
          id: userMessageId,
          type: 'userMessage',
          turnId,
          content: [{ type: 'text', text: prompt }],
        },
      },
    });

    const currentTurn: CurrentTurn = {
      turnId,
      clientThreadId: threadId,
      prompt,
      messageItemId: randomUUID(),
      reasoningItemId: randomUUID(),
      hasEmittedMessageStart: false,
      hasEmittedReasoningStart: false,
      hasEmittedReasoningComplete: false,
      accumulatedText: '',
    };

    if (!session) {
      const args = [
        '--dangerously-skip-permissions',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ];
      if (agyConversationId) {
        args.push('--conversation', agyConversationId);
      }
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);

      const cwd = (params.cwd as string) || homedir();
      console.log(`[agy] Spawning new persistent session for thread ${threadId} (model: ${model}, effort: ${effort}, conv: ${agyConversationId})`);

      const child = spawn(this.agyPath, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HTTP_PROXY: process.env.HTTP_PROXY || 'http://127.0.0.1:7890',
          HTTPS_PROXY: process.env.HTTPS_PROXY || 'http://127.0.0.1:7890',
          http_proxy: process.env.http_proxy || 'http://127.0.0.1:7890',
          https_proxy: process.env.https_proxy || 'http://127.0.0.1:7890',
          ALL_PROXY: process.env.ALL_PROXY || 'http://127.0.0.1:7890',
          all_proxy: process.env.all_proxy || 'http://127.0.0.1:7890',
        },
      });

      const rl = createInterface({ input: child.stdout });
      session = {
        child,
        rl,
        agyConversationId,
        currentTurn,
        lastUsed: Date.now(),
        model,
        effort,
      };
      this.sessions.set(threadId, session);
      if (agyConversationId) {
        this.sessions.set(agyConversationId, session);
      }
      this.setupSessionListeners(threadId, session);
    } else {
      console.log(`[agy] Reusing warm persistent session for thread ${threadId} (turn ${turnId})`);
      session.currentTurn = currentTurn;
      session.lastUsed = Date.now();
    }

    // Write input turn to stdin
    const streamInput = JSON.stringify({
      event: 'user',
      message: { content: prompt },
    }) + '\n';
    session.child.stdin.write(streamInput);

    return { turn: { id: turnId } };
  }

  private setupSessionListeners(threadId: string, session: ThreadSession): void {
    const child = session.child;
    const rl = session.rl;

    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) {
        console.log(`[agy stdout info] ${trimmed}`);
        return;
      }

      try {
        const event = JSON.parse(trimmed);
        const cur = session.currentTurn;
        const targetThreadId = cur?.clientThreadId || threadId;

        if (event.event === 'init' && event.conversation_id) {
          session.agyConversationId = event.conversation_id;
          this.conversationMap.set(threadId, event.conversation_id);
          this.conversationMap.set(event.conversation_id, event.conversation_id);
          if (cur?.clientThreadId) {
            this.conversationMap.set(cur.clientThreadId, event.conversation_id);
          }
          this.sessions.set(event.conversation_id, session);
          console.log(`[agy] Mapped client thread ${threadId} (client: ${cur?.clientThreadId}) -> agy conversation ${event.conversation_id}`);
        }

        if (!cur) {
          return;
        }

        const turnId = cur.turnId;

        if (event.event === 'step_update') {
          const su = event.step_update;

          // Handle tool call steps (e.g. bash commands, web search)
          if (su?.step_type === 'tool') {
            const toolCmd = su.tool_info?.parameters?.CommandLine || su.tool_info?.name || su.tool_name || 'tool';
            const toolItemId = `tool-${su.step_index ?? randomUUID()}`;
            if (su.state === 'ACTIVE') {
              this.emit('notification', {
                method: 'item/started',
                params: {
                  threadId: targetThreadId,
                  item: {
                    id: toolItemId,
                    type: 'commandExecution',
                    turnId,
                    command: toolCmd,
                    aggregatedOutput: '',
                    status: 'running',
                  },
                },
              });
            } else if (su.state === 'DONE') {
              const output = typeof su.tool_info?.output === 'string'
                ? su.tool_info.output
                : JSON.stringify(su.tool_info?.output ?? '');
              this.emit('notification', {
                method: 'item/completed',
                params: {
                  threadId: targetThreadId,
                  item: {
                    id: toolItemId,
                    type: 'commandExecution',
                    turnId,
                    command: toolCmd,
                    aggregatedOutput: output,
                    status: 'completed',
                  },
                },
              });
            }
          }

          // Handle thinking/reasoning delta
          if (su?.thinking_delta) {
            if (!cur.hasEmittedReasoningStart) {
              this.emit('notification', {
                method: 'item/started',
                params: {
                  threadId: targetThreadId,
                  item: { id: cur.reasoningItemId, type: 'reasoning', turnId, summary: [] },
                },
              });
              cur.hasEmittedReasoningStart = true;
            }
            this.emit('notification', {
              method: 'item/reasoning/summaryTextDelta',
              params: { threadId: targetThreadId, itemId: cur.reasoningItemId, turnId, summaryIndex: 0, delta: su.thinking_delta },
            });
          }

          // Handle text delta (the main response content)
          if (su?.text_delta) {
            // Close reasoning item if it was open
            if (cur.hasEmittedReasoningStart && !cur.hasEmittedReasoningComplete) {
              this.emit('notification', {
                method: 'item/completed',
                params: {
                  threadId: targetThreadId,
                  item: { id: cur.reasoningItemId, type: 'reasoning', turnId },
                },
              });
              cur.hasEmittedReasoningComplete = true;
            }

            cur.accumulatedText += su.text_delta;
            if (!cur.hasEmittedMessageStart) {
              this.emit('notification', {
                method: 'item/started',
                params: {
                  threadId: targetThreadId,
                  item: { id: cur.messageItemId, type: 'agentMessage', turnId, content: [{ type: 'text', text: '' }], text: '' },
                },
              });
              cur.hasEmittedMessageStart = true;
            }
            this.emit('notification', {
              method: 'item/agentMessage/delta',
              params: { threadId: targetThreadId, itemId: cur.messageItemId, turnId, delta: su.text_delta },
            });
          }
        }

        if (event.event === 'result') {
          const isError = event.result?.status === 'ERROR' || !!event.result?.error;
          let finalResponse = event.result?.response ?? event.response ?? cur.accumulatedText ?? '';

          if (isError) {
            const rawError = event.result?.error || 'AGY 执行发生错误';
            console.error(`[agy] Turn ${turnId} error in result event:`, rawError);
            if (rawError.includes('Eligib') || rawError.includes('eligible') || rawError.includes('资格')) {
              console.warn(`[agy] Eligibility error detected in result event, restoring golden token...`);
              this.ensureValidToken();
            }
            finalResponse = `❌ **[AGY 执行异常]**\n\n\`\`\`\n${rawError.trim()}\n\`\`\``;
          } else if (!finalResponse.trim()) {
            finalResponse = '（任务已完成，无额外文本输出）';
          }

          // Close reasoning if still open
          if (cur.hasEmittedReasoningStart && !cur.hasEmittedReasoningComplete) {
            this.emit('notification', {
              method: 'item/completed',
              params: {
                threadId: targetThreadId,
                item: { id: cur.reasoningItemId, type: 'reasoning', turnId },
              },
            });
            cur.hasEmittedReasoningComplete = true;
          }

          // If no message was started yet, emit started now
          if (!cur.hasEmittedMessageStart) {
            this.emit('notification', {
              method: 'item/started',
              params: {
                threadId: targetThreadId,
                item: { id: cur.messageItemId, type: 'agentMessage', turnId, content: [{ type: 'text', text: finalResponse }], text: finalResponse },
              },
            });
            cur.hasEmittedMessageStart = true;
          } else if (isError) {
            // Append error text delta if message was already started
            this.emit('notification', {
              method: 'item/agentMessage/delta',
              params: { threadId: targetThreadId, itemId: cur.messageItemId, turnId, delta: `\n\n${finalResponse}` },
            });
          }

          // Emit item/completed for the message
          this.emit('notification', {
            method: 'item/completed',
            params: {
              threadId: targetThreadId,
              item: { id: cur.messageItemId, type: 'agentMessage', turnId, content: [{ type: 'text', text: finalResponse }], text: finalResponse },
            },
          });

          // Emit turn/completed
          this.emit('notification', {
            method: 'turn/completed',
            params: {
              threadId: targetThreadId,
              agyConversationId: session.agyConversationId,
              turn: {
                id: turnId,
                ...(isError ? { error: { message: event.result?.error || 'AGY execution error' } } : {}),
              },
            },
          });

          if (isError) {
            console.log(`[agy] Turn ${turnId} completed with error for thread ${targetThreadId}`);
          } else {
            console.log(`[agy] Turn ${turnId} completed successfully for thread ${targetThreadId} (session kept alive)`);
          }
          cur.hasEmittedMessageStart = false;
          cur.hasEmittedReasoningStart = false;
          cur.hasEmittedReasoningComplete = false;
          session.currentTurn = undefined;
          session.lastUsed = Date.now();
        }
      } catch (error) {
        console.error('[agy] Failed to parse stream event:', line, error);
      }
    });

    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      console.error('[agy] Process error for thread', threadId, error);
      const cur = session.currentTurn;
      const targetThreadId = cur?.clientThreadId || threadId;
      if (cur) {
        this.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId: targetThreadId,
            agyConversationId: session.agyConversationId,
            turn: { id: cur.turnId, error: { message: error.message } },
          },
        });
        session.currentTurn = undefined;
      }
      this.sessions.delete(threadId);
      if (session.agyConversationId) this.sessions.delete(session.agyConversationId);
    });

    child.on('exit', (code) => {
      console.log(`[agy] Process for thread ${threadId} exited with code ${code}`);
      const cur = session.currentTurn;
      const targetThreadId = cur?.clientThreadId || threadId;
      if (cur) {
        const errorMsg = stderr.trim() || `agy exited with code ${code}`;
        if (errorMsg.includes('Eligib') || errorMsg.includes('eligible') || errorMsg.includes('资格')) {
          console.warn(`[agy] Eligibility error detected on exit, restoring golden token...`);
          this.ensureValidToken();
        }
        if (!cur.hasEmittedMessageStart) {
          this.emit('notification', {
            method: 'item/started',
            params: {
              threadId: targetThreadId,
              item: { id: cur.messageItemId, type: 'agentMessage', turnId: cur.turnId, content: [{ type: 'text', text: `❌ **[AGY 进程退出]** (code ${code})\n\n\`\`\`\n${errorMsg}\n\`\`\`` }], text: `❌ **[AGY 进程退出]** (code ${code})\n\n\`\`\`\n${errorMsg}\n\`\`\`` },
            },
          });
          cur.hasEmittedMessageStart = true;
          this.emit('notification', {
            method: 'item/completed',
            params: {
              threadId: targetThreadId,
              item: { id: cur.messageItemId, type: 'agentMessage', turnId: cur.turnId, content: [{ type: 'text', text: `❌ **[AGY 进程退出]** (code ${code})\n\n\`\`\`\n${errorMsg}\n\`\`\`` }], text: `❌ **[AGY 进程退出]** (code ${code})\n\n\`\`\`\n${errorMsg}\n\`\`\`` },
            },
          });
        }
        this.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId: targetThreadId,
            agyConversationId: session.agyConversationId,
            turn: { id: cur.turnId, error: { message: errorMsg } },
          },
        });
        session.currentTurn = undefined;
      }
      this.sessions.delete(threadId);
      if (session.agyConversationId) this.sessions.delete(session.agyConversationId);
    });
  }

  private async steerTurn(params: ObjectMap): Promise<ObjectMap> {
    const threadId = params.threadId as string;
    const agyConvId = this.conversationMap.get(threadId);
    console.log(`[agy] Auto-interrupting active turn for thread ${threadId} to start new turn via steer`);
    this.killProcess(threadId);
    if (agyConvId) this.killProcess(agyConvId);

    const deadline = Date.now() + 3000;
    while ((this.sessions.has(threadId) || (agyConvId && this.sessions.has(agyConvId))) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }

    return this.startTurn(params);
  }

  private interruptTurn(params: ObjectMap): ObjectMap {
    const threadId = params.threadId as string;
    this.killProcess(threadId);
    return {};
  }

  private killProcess(threadId: string): void {
    const agyConvId = this.conversationMap.get(threadId);
    const session = this.sessions.get(threadId) || (agyConvId ? this.sessions.get(agyConvId) : undefined);
    if (session) {
      const cur = session.currentTurn;
      if (cur) {
        const targetThreadId = cur.clientThreadId || threadId;
        this.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId: targetThreadId,
            agyConversationId: session.agyConversationId,
            turn: { id: cur.turnId, error: { message: 'Turn interrupted by user' } },
          },
        });
        session.currentTurn = undefined;
      }
      if (session.child.exitCode === null) {
        session.child.kill('SIGTERM');
        setTimeout(() => { if (session.child.exitCode === null) session.child.kill('SIGKILL'); }, 3000);
      }
      this.sessions.delete(threadId);
      if (agyConvId) this.sessions.delete(agyConvId);
      if (session.agyConversationId) this.sessions.delete(session.agyConversationId);
    }
  }

  private extractPrompt(input: unknown): string {
    if (!Array.isArray(input)) return '';
    return input
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text ?? '')
      .join('\n')
      .trim();
  }

  async stop(): Promise<void> {
    for (const [threadId, session] of this.sessions) {
      if (session.child.exitCode === null) {
        session.child.kill('SIGTERM');
      }
    }
    this.sessions.clear();
    this.ready = false;
  }
}
