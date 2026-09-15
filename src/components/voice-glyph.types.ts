export type VoiceGlyphName = 'settings' | 'captions' | 'mic' | 'mic-off' | 'close' | 'waveform';

export type VoiceGlyphProps = {
  name: VoiceGlyphName;
  color: string;
  size?: number;
};
