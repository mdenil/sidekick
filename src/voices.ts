// Canonical list of server (Deepgram Aura-2) TTS voices. Shared by the
// per-session identity sheet (src/sessionDrawer.ts) and kept in sync with
// the static <select id="set-voice"> options in index.html — if you add or
// remove a voice, update BOTH places.

export interface VoiceOption {
  value: string;
  label: string;
}

export const DEFAULT_VOICE = 'aura-2-thalia-en';

export const AURA_VOICES: VoiceOption[] = [
  { value: 'aura-2-thalia-en', label: 'Thalia (F, warm)' },
  { value: 'aura-2-luna-en', label: 'Luna (F, soft)' },
  { value: 'aura-2-athena-en', label: 'Athena (F, mature)' },
  { value: 'aura-2-hera-en', label: 'Hera (F, confident)' },
  { value: 'aura-2-stella-en', label: 'Stella (F, friendly)' },
  { value: 'aura-2-zeus-en', label: 'Zeus (M, commanding)' },
  { value: 'aura-2-orion-en', label: 'Orion (M, deep)' },
  { value: 'aura-2-arcas-en', label: 'Arcas (M, natural)' },
  { value: 'aura-2-perseus-en', label: 'Perseus (M, youthful)' },
];

/** Human label for a voice value, or the raw value if unknown. */
export function voiceLabel(value: string | undefined): string {
  if (!value) return '';
  return AURA_VOICES.find(v => v.value === value)?.label ?? value;
}
