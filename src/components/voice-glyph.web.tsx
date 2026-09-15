import type { VoiceGlyphProps } from './voice-glyph.types';

export type { VoiceGlyphName } from './voice-glyph.types';

export function VoiceGlyph({ name, color, size = 25 }: VoiceGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {name === 'settings' && (
        <>
          <path d="M3 7h7m4 0h7M3 17h3m4 0h11" />
          <circle cx="12" cy="7" r="2" />
          <circle cx="8" cy="17" r="2" />
        </>
      )}
      {name === 'captions' && <path d="M4 6h16M4 12h10M4 18h6" />}
      {(name === 'mic' || name === 'mic-off') && (
        <>
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6" />
          {name === 'mic-off' && <path d="m2 2 20 20" />}
        </>
      )}
      {name === 'close' && <path d="m5 5 14 14M19 5 5 19" />}
      {name === 'waveform' && <path d="M3 10v4M7 6v12M12 3v18M17 6v12M21 10v4" />}
    </svg>
  );
}
