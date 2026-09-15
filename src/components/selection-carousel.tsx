import { RNHostView } from '@expo/ui';
import { useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { SelectionCarouselProps } from './selection-carousel.types';

// iOS uses Expo UI's SwiftUI page control. This is the web/Android fallback.
export function SelectionCarousel({
  options,
  value,
  onChange,
  width,
  height = 180,
  preview,
  previewHeight = 0,
  enabled = true,
  disabledHint,
  label,
  testID,
}: SelectionCarouselProps) {
  const scroll = useRef<ScrollView>(null);
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );
  useEffect(() => {
    scroll.current?.scrollTo({ x: index * width, animated: false });
  }, [index, width]);
  const dotStart = Math.max(0, Math.min(index - 3, options.length - 7));

  return (
    <RNHostView matchContents>
      <View style={{ width, height: height + previewHeight }} testID={testID}>
        {preview && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              width,
              height: previewHeight,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {preview}
          </View>
        )}
        <ScrollView
          ref={scroll}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEnabled={enabled}
          accessibilityLabel={label}
          contentOffset={{ x: index * width, y: 0 }}
          onMomentumScrollEnd={(event) => {
            const next = options[Math.round(event.nativeEvent.contentOffset.x / width)];
            if (enabled && next && next.id !== value) onChange(next.id);
          }}
        >
          {options.map((option) => (
            <View
              key={option.id}
              style={[
                styles.page,
                { width, height: height + previewHeight, paddingTop: previewHeight },
              ]}
            >
              <Text style={styles.name}>{option.label}</Text>
              <Text style={styles.description}>
                {!enabled && disabledHint ? disabledHint : option.description}
              </Text>
            </View>
          ))}
        </ScrollView>
        {enabled && (
          <View pointerEvents="none" style={styles.dots}>
            {options.slice(dotStart, dotStart + 7).map((option) => (
              <View
                key={option.id}
                style={[
                  styles.dot,
                  { backgroundColor: option.id === value ? '#FFFFFF' : '#626262' },
                ]}
              />
            ))}
          </View>
        )}
      </View>
    </RNHostView>
  );
}

const styles = StyleSheet.create({
  page: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingBottom: 38,
    gap: 8,
  },
  name: { color: '#FFFFFF', fontSize: 32, fontWeight: '600', textAlign: 'center' },
  description: { color: '#929292', fontSize: 16, textAlign: 'center' },
  dots: {
    position: 'absolute',
    bottom: 15,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
