import { Icon, Text } from '@expo/ui';

import type { VoiceGlyphProps } from './voice-glyph.types';

export type { VoiceGlyphName } from './voice-glyph.types';
const symbols = {
  settings: 'slider.horizontal.3',
  captions: 'text.alignleft',
  mic: 'mic',
  'mic-off': 'mic.slash',
  close: 'xmark',
  waveform: 'waveform',
} as const;

export function VoiceGlyph({ name, color, size = 25 }: VoiceGlyphProps) {
  if (process.env.EXPO_OS === 'ios') return <Icon name={symbols[name]} size={size} color={color} />;
  return (
    <Text textStyle={{ color, fontSize: size }}>
      {name === 'close'
        ? '×'
        : name === 'settings' || name === 'captions'
          ? '☰'
          : name === 'mic-off'
            ? '⊘'
            : '≋'}
    </Text>
  );
}
