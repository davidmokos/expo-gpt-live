import { Button, Column, Host, RNHostView, Spacer } from '@expo/ui';
import {
  accessibilityAddTraits,
  accessibilityLabel,
  contentShape,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import { ActivityIndicator } from 'react-native';

import { VoiceGlyph, type VoiceGlyphName } from '@/components/voice-glyph';
import { theme } from '@/theme';

type Props = {
  icon: VoiceGlyphName;
  label: string;
  onPress: () => void;
  testID: string;
  size?: number;
  disabled?: boolean;
  selected?: boolean;
  prominent?: boolean;
  loading?: boolean;
};

export function VoiceControl({
  icon,
  label,
  onPress,
  testID,
  size = 48,
  disabled = false,
  selected = false,
  prominent = false,
  loading = false,
}: Props) {
  const color = prominent ? '#080808' : theme.text;
  return (
    <Host
      colorScheme="dark"
      matchContents
      style={{ width: size, height: size }}
      accessibilityLabel={process.env.EXPO_OS === 'web' ? label : undefined}
    >
      <Button
        variant="text"
        onPress={onPress}
        disabled={disabled}
        testID={testID}
        style={{ padding: 0, width: size, height: size, borderRadius: size / 2 }}
        modifiers={
          process.env.EXPO_OS === 'ios'
            ? [accessibilityLabel(label), accessibilityAddTraits(selected ? ['isSelected'] : [])]
            : undefined
        }
      >
        <Column
          alignment="center"
          spacing={0}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: prominent ? '#F9F9F9' : selected ? '#363636' : theme.surface,
          }}
          modifiers={process.env.EXPO_OS === 'ios' ? [contentShape(shapes.circle())] : undefined}
        >
          <Spacer flexible />
          {loading ? (
            <RNHostView matchContents>
              <ActivityIndicator color={color} style={{ width: 26, height: 26 }} />
            </RNHostView>
          ) : (
            <VoiceGlyph name={icon} color={color} size={prominent ? 27 : 24} />
          )}
          <Spacer flexible />
        </Column>
      </Button>
    </Host>
  );
}
