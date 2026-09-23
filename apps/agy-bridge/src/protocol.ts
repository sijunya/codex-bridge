// Inlined protocol types from @codex-bridge/protocol
// Stripped Ajv schema validation — agy doesn't need it

export const PROTOCOL_VERSION = 1;
export type ObjectMap = Record<string, any>;
export type BridgeRequest = { type: 'request'; requestId: string; method: string; params: ObjectMap };
export type BridgeEvent = { type: 'event'; epoch: string; seq: number; method: string; params: ObjectMap };

export class BridgeError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export function object(value: unknown): ObjectMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('INVALID_PARAMS', 'Expected an object');
  return value as ObjectMap;
}

export function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) {
    throw new BridgeError('INVALID_PARAMS', `Invalid ${name}`);
  }
  return value;
}

export function parseRequest(value: unknown): BridgeRequest {
  const envelope = object(value);
  if (envelope.type !== 'request') throw new BridgeError('INVALID_REQUEST', 'Expected request envelope');
  text(envelope.requestId, 'requestId', 128);
  text(envelope.method, 'method', 128);
  object(envelope.params);
  return envelope as BridgeRequest;
}

export function errorPayload(error: unknown): ObjectMap {
  if (error instanceof BridgeError) return { code: error.code, message: error.message, details: error.details };
  return { code: 'INTERNAL_ERROR', message: 'Operation failed; inspect the host diagnostics.' };
}
