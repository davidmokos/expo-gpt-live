// Browser access is supplied at runtime and never included in the public bundle.
const STORAGE_KEY = 'live-access-token';
let memoryToken = '';

export function getAccessToken(interactive = false) {
  if (typeof window === 'undefined') return '';
  let token = memoryToken;
  try {
    token = window.sessionStorage.getItem(STORAGE_KEY) ?? memoryToken;
  } catch {}
  if (!token && interactive) {
    token =
      window
        .prompt(
          'Enter the API_TOKEN configured on your voice server. It stays in this browser tab.',
        )
        ?.trim() ?? '';
    memoryToken = token;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, token);
    } catch {}
  }
  return token;
}

export function clearAccessToken() {
  memoryToken = '';
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}
