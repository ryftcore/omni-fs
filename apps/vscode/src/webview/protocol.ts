import type { ConnectionState } from '@omni-fs/core';

/** Backend methods that may be called across the wire. */
export type MethodName =
  | 'listProviders'
  | 'listConnections'
  | 'initialSelection'
  | 'save'
  | 'remove'
  | 'test'
  | 'connect'
  | 'pickFile';

export interface SerializedError {
  readonly message: string;
}

export type ViewToHost =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'request';
      readonly id: number;
      readonly method: MethodName;
      readonly params: unknown;
    };

export type HostToView =
  | { readonly kind: 'response'; readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly kind: 'response';
      readonly id: number;
      readonly ok: false;
      readonly error: SerializedError;
    }
  | { readonly kind: 'event'; readonly event: 'connectionsChanged' }
  | {
      readonly kind: 'event';
      readonly event: 'stateChanged';
      readonly connectionId: string;
      readonly state: ConnectionState;
    };
