import { useSavedPreference } from '@/hooks/use-saved-preference';
import { DEFAULT_VOICE, isLiveVoice } from '@/live/voices';

export function useVoicePreference() {
  const { value, setValue, loaded } = useSavedPreference('live.voice', DEFAULT_VOICE, isLiveVoice);
  return { voice: value, setVoice: setValue, loaded };
}
