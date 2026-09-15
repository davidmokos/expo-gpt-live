import { BottomSheet, Button, Column, Host, Icon, Row, Spacer, Text } from '@expo/ui';
import { accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { useWindowDimensions } from 'react-native';

import { Persona } from '@/components/persona';
import {
  PERSONA_VARIANTS,
  isPersonaVariant,
  type PersonaVariant,
} from '@/components/persona/variants';
import { SelectionCarousel } from '@/components/selection-carousel';
import { VOICES, isLiveVoice, type LiveVoice } from '@/live/voices';

type Props = {
  isPresented: boolean;
  onDismiss: () => void;
  voice: LiveVoice;
  onVoiceChange: (voice: LiveVoice) => void;
  voiceEnabled: boolean;
  voiceLocked: boolean;
  persona: PersonaVariant;
  onPersonaChange: (persona: PersonaVariant) => void;
  personaEnabled: boolean;
};

const voiceOptions = VOICES.map((voice) => ({ ...voice, description: 'Swipe to choose a voice' }));

export function VoiceSettings({
  isPresented,
  onDismiss,
  voice,
  onVoiceChange,
  voiceEnabled,
  voiceLocked,
  persona,
  onPersonaChange,
  personaEnabled,
}: Props) {
  const { width } = useWindowDimensions();
  const contentWidth = Math.min(width - 48, 480);
  const [page, setPage] = useState<'voice' | 'persona'>('voice');
  const selectedVoice = VOICES.find((option) => option.id === voice)!;
  const selectedPersona = PERSONA_VARIANTS.find((option) => option.id === persona)!;
  const dismiss = () => {
    onDismiss();
    setPage('voice');
  };
  const haptic = () => {
    if (process.env.EXPO_OS === 'ios') void Haptics.selectionAsync();
  };

  return (
    <Host colorScheme="dark" seedColor="#FFFFFF" style={{ position: 'absolute' }}>
      <BottomSheet
        isPresented={isPresented}
        onDismiss={dismiss}
        containerColor="#1C1C1C"
        contentPadding={{ top: 24, left: 24, right: 24, bottom: 26 }}
        testID="voice-settings-sheet"
      >
        <Column alignment="center" spacing={20} style={{ width: contentWidth }}>
          {page === 'voice' ? (
            <SelectionCarousel
              key="voice"
              options={voiceOptions}
              value={voice}
              width={contentWidth}
              enabled={voiceEnabled}
              disabledHint={
                voiceLocked ? 'End the conversation to change voices.' : 'Loading your voice…'
              }
              label="Voice"
              testID="voice-carousel"
              onChange={(next) => {
                if (!voiceEnabled || !isLiveVoice(next)) return;
                haptic();
                onVoiceChange(next);
              }}
            />
          ) : (
            <SelectionCarousel
              key="persona"
              options={PERSONA_VARIANTS}
              value={persona}
              width={contentWidth}
              height={138}
              preview={
                isPresented ? <Persona variant={persona} size={160} state="idle" /> : undefined
              }
              previewHeight={190}
              enabled={personaEnabled}
              label="Persona appearance"
              testID="persona-carousel"
              onChange={(next) => {
                if (!personaEnabled || !isPersonaVariant(next)) return;
                haptic();
                onPersonaChange(next);
              }}
            />
          )}
          <Button
            variant="text"
            onPress={() => {
              haptic();
              setPage(page === 'voice' ? 'persona' : 'voice');
            }}
            testID={page === 'voice' ? 'persona-settings-button' : 'voice-settings-back'}
            style={{ padding: 0, width: contentWidth, height: 60, borderRadius: 30 }}
            modifiers={
              process.env.EXPO_OS === 'ios'
                ? [
                    accessibilityLabel(
                      page === 'voice'
                        ? `Persona, ${selectedPersona.label}. Change appearance`
                        : `Voice, ${selectedVoice.label}. Back to voices`,
                    ),
                  ]
                : undefined
            }
          >
            <Row
              alignment="center"
              spacing={14}
              style={{
                width: contentWidth,
                height: 60,
                paddingHorizontal: 22,
                borderRadius: 30,
                backgroundColor: '#000000',
              }}
            >
              {process.env.EXPO_OS === 'ios' && (
                <Icon name={page === 'voice' ? 'circle' : 'waveform'} size={23} color="#FFFFFF" />
              )}
              <Text textStyle={{ color: '#FFFFFF', fontSize: 19 }}>
                {page === 'voice' ? 'Persona' : 'Voice'}
              </Text>
              <Spacer flexible />
              <Text textStyle={{ color: '#929292', fontSize: 19 }}>
                {page === 'voice' ? selectedPersona.label : selectedVoice.label}
              </Text>
              {process.env.EXPO_OS === 'ios' ? (
                <Icon name="chevron.right" size={14} color="#929292" />
              ) : (
                <Text textStyle={{ color: '#929292', fontSize: 23 }}>›</Text>
              )}
            </Row>
          </Button>
        </Column>
      </BottomSheet>
    </Host>
  );
}
