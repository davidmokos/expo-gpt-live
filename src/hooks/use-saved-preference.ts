import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

export function useSavedPreference<T extends string>(
  key: string,
  defaultValue: T,
  isValid: (value: unknown) => value is T,
) {
  const [value, updateValue] = useState(defaultValue);
  const [loaded, setLoaded] = useState(false);
  const changed = useRef(false);
  const writes = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(key)
      .then((stored) => {
        // A delayed read must not replace a selection made during startup.
        if (active && !changed.current && isValid(stored)) updateValue(stored);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [key, isValid]);

  const setValue = useCallback(
    (next: T) => {
      if (!isValid(next)) return;
      changed.current = true;
      updateValue(next);
      // Keep rapid carousel selections in order when writing to storage.
      writes.current = writes.current
        .then(() => AsyncStorage.setItem(key, next))
        .catch(() => {
          console.warn(`[Live] Could not save preference: ${key}`);
        });
    },
    [key, isValid],
  );

  return { value, setValue, loaded };
}
