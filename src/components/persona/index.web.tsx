/** WebGL2 renderer for the same bundled AI Elements assets as the native app. */
import { Alignment, Fit, Layout, useRive } from '@rive-app/react-webgl2';
import { Asset } from 'expo-asset';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { theme } from '@/theme';
import {
  PERSONA_MODELS,
  PERSONA_STATE_MACHINE,
  personaInputValues,
  type PersonaProps,
} from './animation';
import { PERSONA_ASSETS } from './assets';
import { DEFAULT_PERSONA, type PersonaVariant } from './variants';

export type { PersonaState, PersonaProps } from './animation';

const LAYOUT = new Layout({ fit: Fit.Contain, alignment: Alignment.Center });

export function Persona({ variant = DEFAULT_PERSONA, ...props }: PersonaProps) {
  return <PersonaRenderer key={variant} variant={variant} {...props} />;
}

function PersonaRenderer({
  variant,
  state = 'idle',
  size = 320,
}: PersonaProps & { variant: PersonaVariant }) {
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const reducedMotion = useReducedMotion();

  // Delay initialization so discarded Strict Mode mounts do not create GPU contexts.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const { rive, RiveComponent } = useRive(
    ready
      ? {
          src: Asset.fromModule(PERSONA_ASSETS[variant]).uri,
          stateMachines: PERSONA_STATE_MACHINE,
          autoBind: PERSONA_MODELS[variant].hasModel,
          autoplay: true,
          layout: LAYOUT,
          onLoadError: () => setFailed(true),
          shouldDisableRiveListeners: true,
        }
      : null,
  );

  useEffect(() => {
    if (!rive) return;
    const values = personaInputValues(state);
    for (const input of rive.stateMachineInputs(PERSONA_STATE_MACHINE) ?? []) {
      const next = values.find(({ name }) => name === input.name);
      if (next) input.value = next.value;
    }
    if (PERSONA_MODELS[variant].dynamicColor)
      rive.viewModelInstance?.color('color')?.rgb(255, 255, 255);
    if (reducedMotion) rive.pause();
    else rive.play(PERSONA_STATE_MACHINE);
  }, [rive, state, variant, reducedMotion]);

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      {failed ? (
        <View
          style={{
            width: size * 0.6,
            height: size * 0.6,
            borderRadius: size,
            borderWidth: 1,
            borderColor: theme.accentMuted,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: theme.secondary, fontSize: 12 }}>Visual unavailable</Text>
        </View>
      ) : (
        <RiveComponent
          aria-hidden="true"
          style={{ width: size, height: size, pointerEvents: 'none' }}
        />
      )}
    </View>
  );
}
