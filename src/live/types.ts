import type { LiveVoice } from './voices';

export type LiveStatus = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';
export type TranscriptEntry = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  startMs: number;
  endMs?: number;
};
export type LiveSnapshot = {
  status: LiveStatus;
  error: string | null;
  muted: boolean;
  inputLevel: number;
  outputLevel: number;
  elapsedSeconds: number;
  transcript: TranscriptEntry[];
};
export type LiveEvent = {
  type: string;
  client_event_id?: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  error?: { message?: string; code?: string };
  usage?: { seconds?: number };
};
export type AudioStats = {
  inputLevel: number;
  outputLevel: number;
  sentPackets: number;
  receivedPackets: number;
};
export interface LiveTransport {
  offer(): Promise<string>;
  answer(sdp: string): Promise<void>;
  send(event: { type: string; event_id?: string }): boolean;
  setMuted(muted: boolean): void;
  stats(): Promise<AudioStats>;
  close(): void;
}
export type TransportCallbacks = {
  onEvent: (event: LiveEvent) => void;
  onFailure: (message: string) => void;
};
export type TransportFactory = (callbacks: TransportCallbacks) => Promise<LiveTransport>;
export interface SessionAPI {
  prepare?(): void;
  create(sdp: string, voice?: LiveVoice): Promise<{ sdp: string; sessionId: string }>;
  close(sessionId: string): Promise<void>;
}
