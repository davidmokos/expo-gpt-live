import { DarkTheme, ThemeProvider } from 'expo-router/react-navigation';
import { Stack } from 'expo-router/stack';
import { StatusBar } from 'expo-status-bar';

import { theme } from '@/theme';

export default function RootLayout() {
  return (
    <ThemeProvider
      value={{
        ...DarkTheme,
        colors: {
          ...DarkTheme.colors,
          background: theme.background,
          card: theme.surface,
          primary: theme.accent,
        },
      }}
    >
      <StatusBar style="light" />
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }}
      >
        <Stack.Screen name="index" options={{ title: 'Live' }} />
      </Stack>
    </ThemeProvider>
  );
}
