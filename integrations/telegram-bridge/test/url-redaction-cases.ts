const address = "https://example.test/view";
const apostrophes = [
  ["opening apostrophe", address + "?token='FAKE_SECRET"],
  ["embedded apostrophe", address + "?token=FAKE_'SECRET"],
  ["paired apostrophes", address + "?token='FAKE_SECRET'"],
  ["apostrophe in signature", address + "?code='FAKE_SECRET"],
  ["apostrophe in fragment", address + "#access_token='FAKE_SECRET"],
] as const;
const escapedSlashes = [
  ["escaped slash code", address + "?code=FAKE_SECRET"],
  ["escaped slash token", address + "?token=FAKE_SECRET"],
  ["escaped slash signature", address + "?sig=FAKE_SECRET"],
  ["escaped slash fragment", address + "#code=FAKE_SECRET"],
  ["escaped slash apostrophe", address + "?token='FAKE_SECRET"],
] as const;
const escapeSlashes = (text: string) => text.replaceAll("/", "\\/");

// Exercise each URI shape as text, JSON, and an escaped JSON string at the outbound boundary.
export const urlRedactionCases = [
  ...apostrophes.flatMap(([label, input]) => [
    { label: "plain " + label, input, expected: address },
    { label: "JSON " + label, input: JSON.stringify({ url: input }), expected: JSON.stringify({ url: address }) },
    { label: "escaped JSON " + label, input: JSON.stringify(JSON.stringify({ url: input })),
      expected: JSON.stringify(JSON.stringify({ url: address })) },
  ]),
  ...escapedSlashes.flatMap(([label, input]) => {
    const json = escapeSlashes(JSON.stringify({ url: input }));
    const expected = escapeSlashes(JSON.stringify({ url: address }));
    return [
      { label: "JSON " + label, input: json, expected },
      { label: "escaped JSON " + label, input: JSON.stringify(json), expected: JSON.stringify(expected) },
    ];
  }),
  { label: "mixed slash escapes", input: '{"url":"https:\\//example.test\\/view?code=FAKE_SECRET"}',
    expected: '{"url":"https:\\//example.test\\/view"}' },
  { label: "apostrophe in retained path", input: "https://example.test/it's/view?code=FAKE_SECRET",
    expected: "https://example.test/it's/view" },
  { label: "plain URL without credentials", input: "https://example.test/it's/view",
    expected: "https://example.test/it's/view" },
  { label: "escaped slash URL without credentials", input: '{"url":"https:\\/\\/example.test\\/view"}',
    expected: '{"url":"https:\\/\\/example.test\\/view"}' },
];
