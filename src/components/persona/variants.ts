export const PERSONA_VARIANTS = [
  { id: 'obsidian', label: 'Obsidian', description: 'Shifting silver' },
  { id: 'mana', label: 'Mana', description: 'Soft blue light' },
  { id: 'opal', label: 'Opal', description: 'Flowing color' },
  { id: 'halo', label: 'Halo', description: 'A ring of light' },
  { id: 'glint', label: 'Glint', description: 'A pair of stars' },
  { id: 'command', label: 'Command', description: 'A simple slash' },
] as const;

export type PersonaVariant = (typeof PERSONA_VARIANTS)[number]['id'];
export const DEFAULT_PERSONA: PersonaVariant = 'opal';

export function isPersonaVariant(value: unknown): value is PersonaVariant {
  return PERSONA_VARIANTS.some((variant) => variant.id === value);
}
