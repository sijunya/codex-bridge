import { EventEmitter } from 'node:events';
import { hostname, homedir } from 'node:os';
import { BridgeError, PROTOCOL_VERSION, object, text, errorPayload, type ObjectMap, type BridgeRequest } from './protocol.js';
import { Store, hash } from './store.js';
import { Workspace } from './workspace.js';
import type { RpcPeer } from './agy.js';

export class Controller extends EventEmitter {
  readonly workspace: Workspace;
  private threadLocks = new Set<string>();
  private loaded = new Set<string>();

  constructor(readonly store: Store, readonly agy: RpcPeer) {
    super();
    this.workspace = new Workspace(store);

    // Forward agy notifications as bridge events
    agy.on('notification', (message: ObjectMap) => this.notification(message));

    agy.on('disconnected', () => {
      store.db.exec("UPDATE threads SET state='unknown' WHERE state IN ('running','starting');");
      this.loaded.clear();
      this.publish('bridge/upstreamLost', { message: 'agy process exited. Restart the bridge.' });
    });
  }

  publish(method: string, params: ObjectMap): void {
    this.emit('event', this.store.append(method, params));
  }

  info(): ObjectMap {
    const runtime = this.store.runtime();
    return {
      protocolVersion: PROTOCOL_VERSION,
      bridgeVersion: '0.1.0',
      codexVersion: 'agy-0.1.0',
      hostName: hostname(),
      platform: process.platform,
      homeDirectory: homedir(),
      epoch: this.store.epoch,
      ready: this.agy.ready,
      runningTasks: runtime.threads.filter((entry: any) => ['running', 'starting'].includes(entry.state)).length,
      pendingRequests: 0,
      capabilities: ['threads', 'streaming', 'models', 'modes', 'files', 'diff', 'replay', 'imageUpload'],
    };
  }

  private notification(message: ObjectMap): void {
    const params = message.params ?? {};
    if (message.method === 'turn/started') this.store.threadState(params.threadId, 'running', params.turn?.id);
    if (message.method === 'turn/completed') {
      this.store.threadState(params.threadId, 'idle');
    }
    this.publish(message.method, params);
  }

  async request(device: string, request: BridgeRequest): Promise<ObjectMap> {
    const digest = hash(JSON.stringify({ method: request.method, params: request.params }));
    try {
      const previous = this.store.beginRequest(device, request.requestId, digest);
      if (previous) return previous;
    } catch (error) { return { type: 'response', requestId: request.requestId, error: errorPayload(error) }; }

    let response: ObjectMap;
    let unknown = false;
    try {
      response = { type: 'response', requestId: request.requestId, result: await this.dispatch(request.method, request.params) };
    } catch (error) {
      unknown = error instanceof BridgeError && ['OUTCOME_UNKNOWN', 'UPSTREAM_LOST'].includes(error.code);
      response = { type: 'response', requestId: request.requestId, error: errorPayload(error) };
    }
    this.store.finishRequest(device, request.requestId, response, unknown);
    return response;
  }

  async dispatch(method: string, params: ObjectMap): Promise<any> {
    // Bridge-level methods
    if (method === 'bridge/info') return this.info();
    if (method === 'bridge/runtime') return this.store.runtime();

    // Project methods
    if (method === 'projects/list') return { projects: this.store.projects() };
    if (method === 'projects/add') return this.workspace.register(text(params.path, 'path'), typeof params.name === 'string' ? params.name.slice(0, 100) : undefined);
    if (method === 'projects/remove') { this.store.removeProject(text(params.projectId, 'projectId')); return {}; }

    // Workspace / file methods
    if (method.startsWith('files/') || method === 'git/status') return this.workspace.dispatch(method, params);

    // Agy must be ready for the rest
    if (!this.agy.ready) throw new BridgeError('UPSTREAM_LOST', 'agy is offline; restart the bridge');

    // Prepare input - strip bridge-specific fields
    const input = structuredClone(params);
    const projectId = input.projectId as string | undefined;
    delete input.projectId;
    delete input.permissionMode;
    delete input.confirmExternalStopped;

    // Thread list - pass cwd from project
    if (method === 'thread/list' && projectId) {
      input.cwd = this.store.project(projectId).path;
    }

    // Thread start
    if (method === 'thread/start') {
      const project = this.store.project(text(projectId!, 'projectId'));
      input.cwd = project.path;
      const result = await this.agy.request(method, input);
      this.store.ownThread(result.thread.id, project.id);
      this.loaded.add(result.thread.id);
      return result;
    }

    // Thread resume / fork
    if (method === 'thread/resume' || method === 'thread/fork') {
      const project = projectId ? this.store.project(projectId) : this.store.projects()[0];
      const threadId = text(input.threadId, 'threadId');

      // Track thread ownership
      if (project && !this.store.thread(threadId)) {
        this.store.ownThread(threadId, project.id);
      }
      this.loaded.add(threadId);

      const result = await this.agy.request('thread/read', { threadId, includeTurns: true });
      return {
        ...result,
        cwd: result.thread?.cwd || project?.path || homedir(),
        model: 'gemini-3.8-flash-high',
        modelProvider: 'google',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'dangerFullAccess' },
      };
    }

    // Turn start - the main action
    if (method === 'turn/start') {
      const threadId = text(input.threadId, 'threadId');
      let owned = this.store.thread(threadId);
      if (!owned) {
        const p = projectId ? this.store.project(projectId) : this.store.projects()[0];
        if (p) {
          this.store.ownThread(threadId, p.id);
          owned = this.store.thread(threadId);
        }
      }
      this.loaded.add(threadId);

      if (this.threadLocks.has(threadId) || (owned && ['running', 'starting'].includes(owned.state))) {
        const deadline = Date.now() + 2500;
        while ((this.threadLocks.has(threadId) || ['running', 'starting'].includes(this.store.thread(threadId)?.state ?? '')) && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 50));
        }
        owned = this.store.thread(threadId);
        if (this.threadLocks.has(threadId) || (owned && ['running', 'starting'].includes(owned.state))) {
          throw new BridgeError('THREAD_BUSY', 'Use steer or wait for the active turn');
        }
      }

      this.threadLocks.add(threadId);
      this.store.threadState(threadId, 'starting');
      try {
        const result = await this.agy.request(method, input);
        if (this.store.thread(threadId)?.state === 'starting') {
          this.store.threadState(threadId, 'running', result.turn?.id);
        }
        return result;
      } catch (error) {
        this.store.threadState(threadId, error instanceof BridgeError && ['OUTCOME_UNKNOWN', 'UPSTREAM_LOST'].includes(error.code) ? 'unknown' : 'idle');
        throw error;
      } finally {
        this.threadLocks.delete(threadId);
      }
    }

    // Turn steer/interrupt
    if (method === 'turn/steer' || method === 'turn/interrupt') {
      return this.agy.request(method, input);
    }

    // Thread metadata operations
    if (['thread/name/set', 'thread/archive', 'thread/unarchive'].includes(method)) {
      return this.agy.request(method, input);
    }

    // Thread read
    if (method === 'thread/read') {
      return this.agy.request(method, input);
    }

    // Passthrough to agy for model/list, skills/list, etc.
    return this.agy.request(method, input);
  }
}
