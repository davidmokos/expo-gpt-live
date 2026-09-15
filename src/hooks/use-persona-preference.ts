import { DEFAULT_PERSONA, isPersonaVariant } from '@/components/persona/variants';
import { useSavedPreference } from '@/hooks/use-saved-preference';

export function usePersonaPreference() {
  const { value, setValue, loaded } = useSavedPreference(
    'live.persona',
    DEFAULT_PERSONA,
    isPersonaVariant,
  );
  return { variant: value, setVariant: setValue, loaded };
}
