import type { ComponentProps, CSSProperties } from 'react';
import { Persona } from './persona';
import { PERSONA_VARIANTS, isPersonaVariant } from './persona/variants';
import { WebSheet } from './web-sheet';
import { VOICES, isLiveVoice } from '@/live/voices';

type Props = ComponentProps<typeof import('./voice-settings').VoiceSettings>;
const selectStyle: CSSProperties = {
  width: '100%',
  padding: '16px 18px',
  marginTop: 10,
  color: '#FFFFFF',
  background: '#000000',
  border: 0,
  borderRadius: 16,
  font: 'inherit',
};

export function VoiceSettings(props: Props) {
  return (
    <WebSheet
      isPresented={props.isPresented}
      onDismiss={props.onDismiss}
      title="Voice and appearance"
    >
      <label style={{ display: 'block' }}>
        Voice
        <select
          aria-label="Voice"
          value={props.voice}
          disabled={!props.voiceEnabled}
          style={selectStyle}
          onChange={(event) => {
            if (props.voiceEnabled && isLiveVoice(event.target.value))
              props.onVoiceChange(event.target.value);
          }}
        >
          {VOICES.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {props.voiceLocked && (
        <p style={{ color: '#A1A1A6', fontSize: 14 }}>End the conversation to change voices.</p>
      )}
      <div style={{ display: 'flex', justifyContent: 'center', margin: '24px 0' }}>
        {props.isPresented && <Persona variant={props.persona} size={140} state="idle" />}
      </div>
      <label style={{ display: 'block' }}>
        ◯ Persona
        <select
          aria-label="Persona"
          value={props.persona}
          disabled={!props.personaEnabled}
          style={selectStyle}
          onChange={(event) => {
            if (props.personaEnabled && isPersonaVariant(event.target.value))
              props.onPersonaChange(event.target.value);
          }}
        >
          {PERSONA_VARIANTS.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </WebSheet>
  );
}
