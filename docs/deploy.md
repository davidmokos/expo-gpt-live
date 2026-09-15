# EAS deployment

Use your own EAS project and Apple signing credentials. Set a unique `ios.bundleIdentifier` in `app.json`; set `android.package` if building for Android.

```sh
npx eas-cli@latest login
npx eas-cli@latest init
```

## Deploy the API

Set the server variables. Each command prompts for its value:

```sh
npx eas-cli@latest env:set production --name OPENAI_API_KEY --visibility sensitive
npx eas-cli@latest env:set production --name API_TOKEN --visibility sensitive
EXPO_NO_DOTENV=1 npx expo export --platform web --api-only
EXPO_NO_DOTENV=1 npx eas-cli@latest deploy --prod --environment production
```

Keep the deployment's production URL for the next step. The shared `API_TOKEN` is intended for private testing; use user authentication for a public backend.

## Build for iPhone

Set the hosted URL as `EXPO_PUBLIC_API_URL`. Set `EXPO_PUBLIC_API_TOKEN` to the same value as the server's `API_TOKEN`.

```sh
npx eas-cli@latest env:set preview --name EXPO_PUBLIC_API_URL --visibility plaintext
npx eas-cli@latest env:set preview --name EXPO_PUBLIC_API_TOKEN --visibility sensitive
npx eas-cli@latest build --platform ios --profile preview
```

Follow the signing and device-registration prompts. Open the finished build's installation link in Safari on the registered iPhone.

The `preview` profile creates a standalone Release app. The OpenAI key belongs only in the server environment. Never add it to the preview environment or app config.
