import type { ComponentProps } from 'react';
import { ActivityIndicator, Pressable } from 'react-native';
import { VoiceGlyph } from './voice-glyph';
import { theme } from '@/theme';

type Props = ComponentProps<typeof import('./voice-control').VoiceControl>;

export function VoiceControl({
  icon,
  label,
  onPress,
  testID,
  size = 48,
  disabled,
  selected,
  prominent,
  loading,
}: Props) {
  const color = prominent ? '#080808' : theme.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      onPress={onPress}
      testID={testID}
      disabled={disabled}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: prominent ? '#F9F9F9' : selected ? '#363636' : theme.surface,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color={color} />
      ) : (
        <VoiceGlyph name={icon} color={color} size={prominent ? 27 : 24} />
      )}
    </Pressable>
  );
}
