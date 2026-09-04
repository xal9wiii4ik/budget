// The shape of a COUNT-dependent message.
//
// The forms are the CLDR plural categories `pluralCategory` (./plural.ts) returns
// — mobile computes them itself because Hermes has no `Intl.PluralRules`. English
// needs `one`/`other`; Russian needs `one`/`few`/`many` plus `other` (which it
// uses for fractions: 1.5 операции). Every language therefore fills `one` and
// `other`, and `few`/`many` are optional because en has no such category.
export interface PluralForms {
  one: string;
  few?: string;
  many?: string;
  other: string;
}
