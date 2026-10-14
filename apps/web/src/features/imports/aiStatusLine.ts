// What the AI pass did to this statement, as a line the header can render.
//
// PURE and LANGUAGE-FREE by the house rule (`period.unitLabelKey`,
// `describeOriginalPairError`): this module decides WHICH sentences are true of
// a session and in what order, and returns KEYS plus the counts they need. It
// never holds a sentence, so the ru/en copy — and the ru plural agreement of the
// two counted clauses — stays in the dictionaries where a translator can see it.
//
// `ai_confidence` is deliberately absent from the input: no number on this
// screen is derived from it (plan-web.md — `needs_review` IS the server's
// decision, and a percentage next to a shop name is false precision over a
// figure the user cannot act on).
import type { PluralKey, SimpleKey } from '../../i18n/t';

/** The five arms of `StatementAiStatus` (architecture §"ai_status"). */
export type AiStatus = 'not_configured' | 'skipped' | 'ok' | 'partial' | 'failed';

/**
 * Structural on purpose: the helper takes the three fields it reads, so a test
 * does not have to build a whole session and the shim's shape is not baked in.
 * All three are optional because a pre-ai-layer server does not send them (and
 * an old session honestly reads `not_configured` once it does) — an absent
 * `ai_status` renders NOTHING, which is the right answer for a server that has
 * never run the pass.
 */
export interface AiStatusSource {
  ai_status?: AiStatus;
  ai_rows_suggested?: number;
  ai_rows_flagged?: number;
}

/** One clause: a plain key, or a counted key with the count the dict needs. */
export type AiStatusPart = { key: SimpleKey } | { key: PluralKey; count: number };

export interface AiStatusLine {
  /**
   * `warning` is reserved for the two arms that are NEWS (`partial`, `failed`):
   * the caller gives only those a `role="status"`, because "AI is off" is a
   * fact about the server and does not deserve a screen-reader announcement.
   */
  tone: 'quiet' | 'warning';
  /** Empty means: render nothing at all, not an empty paragraph. */
  parts: AiStatusPart[];
}

const NOTHING: AiStatusLine = { tone: 'quiet', parts: [] };

/**
 * The counted clauses, in the order they are read: what the model did, then
 * what is left to look at. A zero count is OMITTED rather than said — "0 to
 * check" is noise, and "AI suggested a category for 0 lines" is a lie about an
 * `ok` pass that found nothing to do.
 */
function countedParts(source: AiStatusSource): AiStatusPart[] {
  const parts: AiStatusPart[] = [];
  const suggested = source.ai_rows_suggested ?? 0;
  const flagged = source.ai_rows_flagged ?? 0;
  if (suggested > 0) parts.push({ key: 'imports.aiSuggested', count: suggested });
  if (flagged > 0) parts.push({ key: 'imports.aiFlagged', count: flagged });
  return parts;
}

export function aiStatusLine(source: AiStatusSource): AiStatusLine {
  switch (source.ai_status) {
    case undefined:
      return NOTHING;
    case 'not_configured':
      // Not an error and not a warning: this server simply has no provider.
      return { tone: 'quiet', parts: [{ key: 'imports.aiOff' }] };
    case 'skipped':
      // A provider IS configured and still said nothing, which looks like a
      // failure unless the screen says why: the rules covered every line.
      return { tone: 'quiet', parts: [{ key: 'imports.aiSkipped' }] };
    case 'ok':
      return { tone: 'quiet', parts: countedParts(source) };
    case 'partial':
      // The counts are TRUE here (those rows really were suggested) and the
      // note is what makes them honest: the rest were left untouched.
      return { tone: 'warning', parts: [...countedParts(source), { key: 'imports.aiPartial' }] };
    case 'failed':
      // Nothing was suggested by definition, so no count is rendered.
      return { tone: 'warning', parts: [{ key: 'imports.aiFailed' }] };
  }
}
