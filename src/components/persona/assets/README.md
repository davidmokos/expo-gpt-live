# AI Elements Persona assets

These are the original Rive assets distributed by [AI Elements Persona](https://elements.ai-sdk.dev/components/persona), downloaded on September 15, 2026. They are bundled unchanged so native Release builds work offline.

Source component: [6a9d5b1822ff](https://raw.githubusercontent.com/vercel/ai-elements/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/persona.tsx). `manifest.json` records each original URL, byte size, and SHA-256 digest. The asset filenames are shortened locally; `opal.riv` is the upstream `orb-1.2.riv`.

AI Elements is Copyright 2023 Vercel, Inc., Apache License 2.0. The upstream notice is retained in `LICENSE.ai-elements` and the full license is in `LICENSE-2.0.txt`. The native and web renderers are adaptations: local asset loading, native Rive bindings, fixed dark-theme colors, reduced motion, paused previews, and the existing Opal default.

## Runtime details

All six files were decoded in the Rive WebGL2 runtime. Every file has a state machine named `default` and boolean inputs `listening`, `thinking`, `speaking`, and `asleep`. Idle clears these four inputs. Other inputs are left untouched.

| Variant  | Upstream file    | View model | Dark-theme color    |
| -------- | ---------------- | ---------- | ------------------- |
| Obsidian | obsidian-2.0.riv | `color`    | White               |
| Mana     | mana-2.0.riv     | `color`    | Original blue       |
| Opal     | orb-1.2.riv      | None       | Original multicolor |
| Halo     | halo-2.0.riv     | `color`    | White               |
| Glint    | glint-2.0.riv    | `color`    | White               |
| Command  | command-2.0.riv  | `color`    | White               |

The 2.0 view model only controls color. Conversation states use the four state-machine booleans, as in the upstream component. Opal also has a numeric `color` input; it is left at its original value. Web uses `@rive-app/react-webgl2`, since Canvas does not render all blur effects in these assets.

The native renderer loads files only when requested and shares at most six decoded files for the app process lifetime. Each rendered view has its own state machine and data model. Switching variants remounts only that view, and a cancelled load cannot update its replacement. The call controller and microphone are independent of this visual.
