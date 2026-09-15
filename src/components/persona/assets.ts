import type { PersonaVariant } from './variants';

// Static requires make every visual available in an offline Release build.
export const PERSONA_ASSETS: Record<PersonaVariant, number> = {
  obsidian: require('./assets/obsidian.riv'),
  mana: require('./assets/mana.riv'),
  opal: require('./assets/opal.riv'),
  halo: require('./assets/halo.riv'),
  glint: require('./assets/glint.riv'),
  command: require('./assets/command.riv'),
};
