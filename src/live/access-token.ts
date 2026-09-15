export function getAccessToken(_interactive = false) {
  return process.env.EXPO_PUBLIC_API_TOKEN ?? '';
}

export function clearAccessToken() {
  // Native tokens come from build configuration, not editable browser storage.
}
