// What to call a statement format in the picker (bank-format-from-server).
//
// The LIST of formats comes from the server (its parser registry is the single
// source of truth), but the NAMES do not: a registry key like `priorbank_csv_v1`
// is an identifier, not copy, and it has no Russian. So the server says what it
// can parse and the client says how to spell it — which also means adding a bank
// server-side never blocks on a client release.
//
// The whole point of this module is the case where those two get out of step:
// a deployed server that parses a bank this build has never heard of. The picker
// must still OFFER it — hiding a format the server supports would make a working
// import unreachable, and throwing on it would take the upload window down over a
// missing string. So an unknown id renders as itself: ugly, honest, and usable.
//
// Pure and language-free by the house rule: it returns a message KEY, never a
// sentence, and the fallback carries the raw id for the caller to print verbatim.
import type { SimpleKey } from '../../i18n/t';

export type StatementFormatLabel =
  /** A format this build has copy for — the caller translates `labelKey`. */
  | { kind: 'known'; labelKey: SimpleKey }
  /** A format this build does not know — the caller prints `label` as it is. */
  | { kind: 'unknown'; label: string };

/**
 * Registry key -> dictionary key. Keys are FROZEN server-side (they are stored in
 * `source_format` on every session), so an entry here is safe to keep forever.
 */
const LABEL_KEYS: Readonly<Record<string, SimpleKey>> = {
  priorbank_csv_v1: 'imports.formatPriorbankCsvV1',
};

export function statementFormatLabel(format: string): StatementFormatLabel {
  const labelKey = LABEL_KEYS[format];
  return labelKey === undefined ? { kind: 'unknown', label: format } : { kind: 'known', labelKey };
}
