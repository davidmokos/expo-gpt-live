import type { ReactElement } from 'react';

export type SelectionOption = { id: string; label: string; description: string };

export type SelectionCarouselProps = {
  options: readonly SelectionOption[];
  value: string;
  onChange: (value: string) => void;
  width: number;
  height?: number;
  preview?: ReactElement;
  previewHeight?: number;
  enabled?: boolean;
  disabledHint?: string;
  label: string;
  testID: string;
};
