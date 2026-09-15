import { Column, RNHostView, Spacer, Text } from '@expo/ui';
import { TabView, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  frame,
  indexViewStyle,
  tabViewStyle,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';

import type { SelectionCarouselProps, SelectionOption } from './selection-carousel.types';

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
  const totalHeight = height + previewHeight;
  // A static page prevents both swipe and page-dot changes during a call.
  if (!enabled) {
    const selected = options.find((option) => option.id === value) ?? options[0];
    return (
      <SelectionPage
        option={{ ...selected, description: disabledHint ?? selected.description }}
        width={width}
        height={height}
        testID={`${testID}-locked`}
      />
    );
  }

  const pager = (
    <TabView
      selection={value}
      onSelectionChange={(next) => {
        if (enabled && next !== value && options.some((option) => option.id === next))
          onChange(next);
      }}
      testID={testID}
      modifiers={[
        frame({ width, height: totalHeight }),
        tabViewStyle({ type: 'page', indexDisplayMode: 'always' }),
        indexViewStyle({ backgroundDisplayMode: 'never' }),
        accessibilityLabel(label),
      ]}
    >
      {options.map((option) => (
        <TabView.Tab key={option.id} value={option.id}>
          <SelectionPage
            option={option}
            width={width}
            height={totalHeight}
            previewHeight={previewHeight}
            testID={`${testID}-${option.id}`}
          />
        </TabView.Tab>
      ))}
    </TabView>
  );

  if (!preview) return pager;
  return (
    <ZStack alignment="top" modifiers={[frame({ width, height: totalHeight })]}>
      <RNHostView matchContents>
        <View
          pointerEvents="none"
          style={{ width, height: previewHeight, alignItems: 'center', justifyContent: 'center' }}
        >
          {preview}
        </View>
      </RNHostView>
      {/* The transparent pager covers the preview, so the entire control swipes. */}
      {pager}
    </ZStack>
  );
}

function SelectionPage({
  option,
  width,
  height,
  previewHeight = 0,
  testID,
}: {
  option: SelectionOption;
  width: number;
  height: number;
  previewHeight?: number;
  testID: string;
}) {
  return (
    <Column
      alignment="center"
      spacing={8}
      style={{ width, height, paddingHorizontal: 16, paddingTop: previewHeight, paddingBottom: 38 }}
      testID={testID}
    >
      <Spacer flexible />
      <Text textStyle={{ color: '#FFFFFF', fontSize: 32, fontWeight: '600', textAlign: 'center' }}>
        {option.label}
      </Text>
      <Text textStyle={{ color: '#929292', fontSize: 16, textAlign: 'center' }}>
        {option.description}
      </Text>
      <Spacer flexible />
    </Column>
  );
}
