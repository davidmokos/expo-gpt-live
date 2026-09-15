import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { LiveSession } from '@/live/session';
import { createTransport } from '@/live/transport';
import { sessionAPI } from '@/live/api';

export function useLiveSession() {
  const [session] = useState(() => new LiveSession(createTransport, sessionAPI));
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(() => {
    const onAppStateChange = (state: typeof AppState.currentState) => {
      // Native iOS audio continues while the screen is locked or another app is
      // open. Only visual updates pause; the microphone keeps its chosen state.
      session.setAppActive(state === 'active');
      if (state === 'background' && process.env.EXPO_OS !== 'ios') void session.stop();
    };
    onAppStateChange(AppState.currentState);
    const listener = AppState.addEventListener('change', onAppStateChange);
    return () => {
      listener.remove();
      void session.stop();
    };
  }, [session]);
  return { ...snapshot, start: session.start, stop: session.stop, toggleMute: session.toggleMute };
}
