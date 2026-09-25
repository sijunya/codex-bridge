import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { BridgeError, type ObjectMap } from './protocol.js';

export interface RpcPeer extends EventEmitter {
  ready: boolean;
  request(method: string, params: ObjectMap, timeout?: number): Promise<any>;
}

const AGY_DATA_DIR = join(homedir(), '.gemini', 'antigravity-cli');
const CONVERSATIONS_DB = join(AGY_DATA_DIR, 'conversation_summaries.db');
const BRAIN_DIR = join(AGY_DATA_DIR, 'brain');

interface CurrentTurn {
  turnId: string;
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

  async start(): Promise<void> {
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
      throw new BridgeError('INVALID_STATE', 'A turn is already in progress for this thread');
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
        env: { ...process.env },
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

        if (event.event === 'init' && event.conversation_id) {
          session.agyConversationId = event.conversation_id;
          this.conversationMap.set(threadId, event.conversation_id);
          this.conversationMap.set(event.conversation_id, event.conversation_id);
          this.sessions.set(event.conversation_id, session);
          console.log(`[agy] Mapped client thread ${threadId} -> agy conversation ${event.conversation_id}`);
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
                  threadId,
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
                  threadId,
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
                  threadId,
                  item: { id: cur.reasoningItemId, type: 'reasoning', turnId, summary: [] },
                },
              });
              cur.hasEmittedReasoningStart = true;
            }
            this.emit('notification', {
              method: 'item/reasoning/summaryTextDelta',
              params: { threadId, itemId: cur.reasoningItemId, turnId, summaryIndex: 0, delta: su.thinking_delta },
            });
          }

          // Handle text delta (the main response content)
          if (su?.text_delta) {
            // Close reasoning item if it was open
            if (cur.hasEmittedReasoningStart && !cur.hasEmittedReasoningComplete) {
              this.emit('notification', {
                method: 'item/completed',
                params: {
                  threadId,
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
                  threadId,
                  item: { id: cur.messageItemId, type: 'agentMessage', turnId, content: [{ type: 'text', text: '' }], text: '' },
                },
              });
              cur.hasEmittedMessageStart = true;
            }
            this.emit('notification', {
              method: 'item/agentMessage/delta',
              params: { threadId, itemId: cur.messageItemId, turnId, delta: su.text_delta },
            });
          }
        }

        if (event.event === 'result') {
          const isError = event.result?.status === 'ERROR' || !!event.result?.error;
          let finalResponse = event.result?.response ?? event.response ?? cur.accumulatedText ?? '';

          if (isError) {
            const rawError = event.result?.error || 'AGY 执行发生错误';
            console.error(`[agy] Turn ${turnId} error in result event:`, rawError);
            finalResponse = `❌ **[AGY 执行异常]**\n\n\`\`\`\n${rawError.trim()}\n\`\`\``;
          } else if (!finalResponse.trim()) {
            finalResponse = '（任务已完成，无额外文本输出）';
          }

          // Close reasoning if still open
          if (cur.hasEmittedReasoningStart && !cur.hasEmittedReasoningComplete) {
            this.emit('notification', {
              method: 'item/completed',
              params: {
                threadId,
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
                threadId,
                item: { id: cur.messageItemId, type: 'agentMessage', turnId, content: [{ type: 'text', text: finalResponse }], text: finalResponse },
              },
            });
            cur.hasEmittedMessageStart = true;
          } else if (isError) {
            // Append error text delta if message was already started
            this.emit('notification', {
              method: 'item/agentMessage/delta',
              params: { threadId, itemId: cur.messageItemId, turnId, delta: `\n\n${finalResponse}` },
            });
          }

          // Emit item/completed for the message
          this.emit('notification', {
            method: 'item/completed',
            params: {
              threadId,
              item: { id: cur.messageItemId, type: 'agentMessage', turnId, content: [{ type: 'text', text: finalResponse }], text: finalResponse },
            },
          });

          // Emit turn/completed
          this.emit('notification', {
            method: 'turn/completed',
            params: {
              threadId,
              turn: {
                id: turnId,
                ...(isError ? { error: { message: event.result?.error || 'AGY execution error' } } : {}),
              },
            },
          });

          if (isError) {
            console.log(`[agy] Turn ${turnId} completed with error`);
          } else {
            console.log(`[agy] Turn ${turnId} completed successfully (session kept alive)`);
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
      if (cur) {
        this.emit('notification', {
          method: 'turn/completed',
          params: { threadId, turn: { id: cur.turnId, error: { message: error.message } } },
        });
      }
      this.sessions.delete(threadId);
      if (session.agyConversationId) this.sessions.delete(session.agyConversationId);
    });

    child.on('exit', (code) => {
      console.log(`[agy] Process for thread ${threadId} exited with code ${code}`);
      const cur = session.currentTurn;
      if (cur) {
        const errorMsg = stderr.trim() || `agy exited with code ${code}`;
        if (!cur.hasEmittedMessageStart) {
          this.emit('notification', {
            method: 'item/started',
            params: {
              threadId,
              item: { id: cur.messageItemId, type: 'agentMessage', turnId: cur.turnId, content: [{ type: 'text', text: `❌ **[AGY 进程退出]** (code ${code})\n\n\`\`\`\n${errorMsg}\n\`\`\`` }], text: `❌ **[AGY 进程退出]** (code ${code})\n\n\`\`\`\n${errorMsg}\n\`\`\`` },
            },
          });
          cur.hasEmittedMessageStart = true;
          this.emit('notification', {
            method: 'item/completed',
            params: {
              threadId,
              item: { id: cur.messageItemId, type: 'agentMessage', turnId: cur.turnId, content: [{ type: 'text', text: `❌ **[AGY 进程退出]** (code ${code})\n\n\`\`\`\n${errorMsg}\n\`\`\`` }], text: `❌ **[AGY 进程退出]** (code ${code})\n\n\`\`\`\n${errorMsg}\n\`\`\`` },
            },
          });
        }
        this.emit('notification', {
          method: 'turn/completed',
          params: { threadId, turn: { id: cur.turnId, error: { message: errorMsg } } },
        });
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
    const session = this.sessions.get(threadId);
    if (session) {
      if (session.child.exitCode === null) {
        session.child.kill('SIGTERM');
        setTimeout(() => { if (session.child.exitCode === null) session.child.kill('SIGKILL'); }, 3000);
      }
      this.sessions.delete(threadId);
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
