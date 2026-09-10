export const sourceLanguages = [
  ["en", "English"],
  ["zh", "Chinese"],
  ["yue", "Cantonese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["ar", "Arabic"],
  ["pt", "Portuguese"],
  ["id", "Indonesian"],
  ["it", "Italian"],
  ["ru", "Russian"],
  ["th", "Thai"],
  ["vi", "Vietnamese"],
  ["tr", "Turkish"],
  ["hi", "Hindi"],
  ["ms", "Malay"],
  ["nl", "Dutch"],
  ["sv", "Swedish"],
  ["da", "Danish"],
  ["fi", "Finnish"],
  ["pl", "Polish"],
  ["cs", "Czech"],
  ["fil", "Filipino"],
  ["fa", "Persian"],
  ["el", "Greek"],
  ["hu", "Hungarian"],
  ["mk", "Macedonian"],
  ["ro", "Romanian"],
].map(([value, label]) => ({ value, label }));

export const targetLanguages = [
  ...sourceLanguages.filter(({ value }) => value !== "zh"),
  { value: "zh-Hant", label: "Chinese (Traditional)" },
  { value: "zh-Hans", label: "Chinese (Simplified)" },
];

export const languageName = (code: string) =>
  [...targetLanguages, ...sourceLanguages].find(
    ({ value, label }) =>
      value === code || label.toLowerCase() === code.toLowerCase(),
  )?.label ?? code;
