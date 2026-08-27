/* Shared DTO types for the admin management pages — mirror the tRPC payloads. */

export type Presence = 'available' | 'busy' | 'away' | 'offline';
export type ExtensionStatus = 'idle' | 'ringing' | 'in_call' | 'held' | 'offline';
export type CallStatus =
  | 'dialing'
  | 'ringing'
  | 'active'
  | 'held'
  | 'completed'
  | 'missed'
  | 'failed';

export type AgentRow = {
  id: number;
  name: string | null;
  email: string | null;
  role: 'user' | 'admin';
  lastSignInAt: Date;
  presence: Presence | null;
  title: string | null;
  department: string | null;
  extensionId: number | null;
  extensionNumber: string | null;
  extensionStatus: ExtensionStatus | null;
  /** client-only: locally invited agents not yet provisioned by the backend */
  invited?: boolean;
}

export type ExtensionRow = {
  extension: {
    id: number;
    number: string;
    label: string | null;
    status: ExtensionStatus;
    createdAt: Date;
  };
  agentName: string | null;
  agentId: number | null;
}

export type LogCall = {
  id: number;
  direction: 'inbound' | 'outbound';
  status: CallStatus;
  fromNumber: string;
  toNumber: string;
  contactName: string | null;
  agentId: number | null;
  extensionId: number | null;
  contactId: number | null;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSec: number;
  muted: boolean;
  hasRecording: boolean;
  note: string | null;
}

export type LogRow = {
  call: LogCall;
  agentName: string | null;
  extensionNumber: string | null;
}

export type CallEventRow = {
  id: number;
  callId: number;
  type: string;
  payload: string | null;
  createdAt: Date;
}

export type FeedEvent = {
  id: number;
  callId: number;
  type: string;
  payload: string | null;
  createdAt: Date;
  contactName: string | null;
  fromNumber: string;
  toNumber: string;
  direction: 'inbound' | 'outbound';
}
