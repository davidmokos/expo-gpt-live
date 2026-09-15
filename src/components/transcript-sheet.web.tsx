import type { ComponentProps } from 'react';
import { WebSheet } from './web-sheet';

type Props = ComponentProps<typeof import('./transcript-sheet').TranscriptSheet>;

export function TranscriptSheet({ isPresented, onDismiss, entries }: Props) {
  const visible = entries.filter(({ text }) => text.trim());
  return (
    <WebSheet isPresented={isPresented} onDismiss={onDismiss} title="Transcript">
      {visible.length ? (
        visible.map((entry) => (
          <p
            key={entry.id}
            aria-label={`${entry.role === 'user' ? 'You' : 'Assistant'}: ${entry.text}`}
            style={{
              lineHeight: 1.6,
              padding: entry.role === 'user' ? 14 : 0,
              borderRadius: 20,
              background: entry.role === 'user' ? '#303032' : 'transparent',
              margin: '0 0 24px',
              whiteSpace: 'pre-wrap',
            }}
          >
            {entry.text.trim()}
          </p>
        ))
      ) : (
        <p style={{ color: '#A1A1A6', textAlign: 'center' }}>Your conversation will appear here.</p>
      )}
    </WebSheet>
  );
}
