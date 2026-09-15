import type { PersonaVariant } from './variants';

export type PersonaState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'asleep';

export interface PersonaProps {
  variant?: PersonaVariant;
  state?: PersonaState;
  size?: number;
}

// All six assets use these state-machine inputs. Color is a view-model property.
export const PERSONA_STATE_MACHINE = 'default';
export const PERSONA_INPUTS = ['listening', 'thinking', 'speaking', 'asleep'] as const;

export const PERSONA_MODELS: Record<PersonaVariant, { hasModel: boolean; dynamicColor: boolean }> =
  {
    obsidian: { hasModel: true, dynamicColor: true },
    mana: { hasModel: true, dynamicColor: false },
    opal: { hasModel: false, dynamicColor: false },
    halo: { hasModel: true, dynamicColor: true },
    glint: { hasModel: true, dynamicColor: true },
    command: { hasModel: true, dynamicColor: true },
  };

export function personaInputValues(state: PersonaState) {
  return PERSONA_INPUTS.map((name) => ({ name, value: name === state }));
}
