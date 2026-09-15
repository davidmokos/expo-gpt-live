// BuiltInVoice in the OpenAI Live API. Voice is selected when a session starts.
// https://developers.openai.com/api/reference/typescript/resources/live
export const VOICES = [
  { id: 'marin', label: 'Marin' },
  { id: 'alloy', label: 'Alloy' },
  { id: 'ash', label: 'Ash' },
  { id: 'ballad', label: 'Ballad' },
  { id: 'beacon', label: 'Beacon' },
  { id: 'bossa', label: 'Bossa' },
  { id: 'cedar', label: 'Cedar' },
  { id: 'cinder', label: 'Cinder' },
  { id: 'coral', label: 'Coral' },
  { id: 'delta', label: 'Delta' },
  { id: 'echo', label: 'Echo' },
  { id: 'gleam', label: 'Gleam' },
  { id: 'meridian', label: 'Meridian' },
  { id: 'quartz', label: 'Quartz' },
  { id: 'ripple', label: 'Ripple' },
  { id: 'sage', label: 'Sage' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'stone', label: 'Stone' },
  { id: 'tempo', label: 'Tempo' },
  { id: 'verse', label: 'Verse' },
  { id: 'vesper', label: 'Vesper' },
  { id: 'willow', label: 'Willow' },
] as const;

export type LiveVoice = (typeof VOICES)[number]['id'];
export const DEFAULT_VOICE: LiveVoice = 'marin';

export function isLiveVoice(value: unknown): value is LiveVoice {
  return typeof value === 'string' && VOICES.some((voice) => voice.id === value);
}
