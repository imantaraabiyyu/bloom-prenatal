// Shared constants for the pregnancy journal (text-only notes + mood).

export const MOODS = [
  { key: "senang", emoji: "😊", label: "Senang" },
  { key: "tenang", emoji: "😌", label: "Tenang" },
  { key: "biasa", emoji: "😐", label: "Biasa" },
  { key: "cemas", emoji: "😟", label: "Cemas" },
  { key: "lelah", emoji: "😴", label: "Lelah" },
  { key: "mual", emoji: "🤢", label: "Mual" },
  { key: "sedih", emoji: "😢", label: "Sedih" },
];

export function moodMeta(key) {
  return MOODS.find((m) => m.key === key) || null;
}
