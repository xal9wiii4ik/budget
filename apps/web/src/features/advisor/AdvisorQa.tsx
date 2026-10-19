// Cited question-and-answer over the user's own operations (rag Web A).
//
// A SECOND section on /advisor, beside the streaming chat and not a mode of it:
// different endpoint, different seam, different failures, and an answer that is
// VERIFIED against what the server retrieved. The chat stays byte-identical.
//
// The ANSWER is the model's own text and is rendered verbatim — never
// translated, never run through `bankPhrases`, no markdown dependency (the
// advisor rule). It is plain text, which is why it renders with
// `white-space: pre-wrap` and is React-escaped like every other string here.
import { zodResolver } from '@hookform/resolvers/zod';
import { ADVISOR_QUESTION_MAX, advisorAskSchema } from '@budget/shared';
import { useMemo } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Textarea } from '../../components/Field';
import { QA_RETRIEVAL_LIMIT, useAskQa } from '../../data/advisorQa';
import { buildCategoryIndex } from '../../data/categoryLookup';
import { useCategories } from '../../data/categories';
import { useLang, useT } from '../../i18n/context';
import type { SimpleKey, Translate } from '../../i18n/t';
import { describeQaError } from '../../lib/errors';
import { SearchTotals } from '../transactions/SearchTotals';
import { QaCitation } from './QaCitation';
import styles from './AdvisorQa.module.css';

// The SAME shared schema (and the same 2000 cap) the chat composer and the
// mobile client use, wrapped in the one-field object react-hook-form wants.
// Validation is not hand-rolled: the trim/blank/length rules mirror the server's
// and live in @budget/shared.
const qaSchema = z.object({ question: advisorAskSchema });
type QaInput = z.input<typeof qaSchema>;
type QaValues = z.output<typeof qaSchema>;

// Filled INTO the field, not sent on click: the user sees and edits what they
// are about to ask (the composer precedent), so these are UI copy and translated.
const EXAMPLE_KEYS: readonly SimpleKey[] = [
  'advisor.qaExample1',
  'advisor.qaExample2',
  'advisor.qaExample3',
];

// The shared schema's messages are documented DEFAULTS, not a contract: the
// section maps the zod issue CODE — which zodResolver puts in `error.type` —
// onto its own dictionary entry, so validation stays shared while the sentence
// follows the chosen language. The same two keys the chat composer uses, because
// it is the same rule being broken.
function questionErrorMessage(type: string | undefined, t: Translate): string {
  return type === 'too_big'
    ? t('advisor.questionTooLong', { max: ADVISOR_QUESTION_MAX })
    : t('advisor.questionRequired');
}

export function AdvisorQa() {
  const lang = useLang();
  const t = useT();
  const ask = useAskQa();
  // The citations render a NAME and an icon, which live on the category — one
  // 60s-cached read the rest of the app already shares. Empty while it is
  // pending or failed, which is `rowTitle`'s own documented fallback arm rather
  // than a blocked answer.
  const categoriesQuery = useCategories();
  const categoryIndex = useMemo(
    () => buildCategoryIndex(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );

  const {
    register,
    handleSubmit,
    control,
    setValue,
    setFocus,
    formState: { errors },
  } = useForm<QaInput, unknown, QaValues>({
    resolver: zodResolver(qaSchema),
    defaultValues: { question: '' },
  });

  const question = useWatch({ control, name: 'question' });

  const onSubmit = handleSubmit((values) => {
    // One question at a time. The button is disabled while pending, and this is
    // the same guard for the keyboard path — a double Cmd/Ctrl+Enter must not
    // buy two model calls.
    if (ask.isPending) return;
    // v1 sends the question and the retrieval size ONLY: narrowing is the search
    // mode's job, and the body's four optional filters have no control here
    // (`rag-qa-filters`). `limit` goes out because the generated body makes it
    // required, and it carries the server's own default (data/advisorQa.ts).
    //
    // The text is NOT cleared on send — it is the question the answer below
    // answers, a blank field over an answer reads as a lost one, and after a 429
    // (which clears `mutation.data`, ruling TC-12) it is the one thing left to
    // ask again with.
    ask.mutate({ question: values.question, limit: QA_RETRIEVAL_LIMIT });
  });

  const fillExample = (text: string) => {
    setValue('question', text, { shouldValidate: false });
    setFocus('question');
  };

  // Everything below is DERIVED during render — no effect, no local copy of the
  // answer, no transcript (D-Q2: v1 has no history, and leaving the page loses
  // the answer, which the lede says out loud).
  //
  // Ruling TC-12 (post-wave-1): a failure — a 429 most of all — REPLACES the
  // previous answer. query-core clears `mutation.data` the moment the next
  // `mutate` goes pending, so there is nothing to render, and keeping a local
  // copy of the last answer alive across a failed ask would be a second source
  // of truth about what the server said. The field keeps the question instead,
  // which is what the user needs to ask again.
  const answer = ask.isPending ? undefined : ask.data;
  const failure = ask.error === null ? null : describeQaError(ask.error, lang, t);
  // One polite announcement when an answer lands, the chat's own key: the panel
  // itself is not a live region, since the answer is not streamed.
  const announcement = answer === undefined ? null : t('advisor.answerReady');

  return (
    <section className={styles.qa}>
      <h2 className={styles.title}>{t('advisor.qaTitle')}</h2>
      <p className={styles.lede}>{t('advisor.qaLede')}</p>

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <label className={styles.label} htmlFor="advisor-qa-question">
          {t('advisor.qaQuestionLabel')}
        </label>
        <Textarea
          id="advisor-qa-question"
          rows={2}
          maxLength={ADVISOR_QUESTION_MAX}
          aria-invalid={errors.question ? true : undefined}
          aria-describedby="advisor-qa-counter"
          placeholder={t('advisor.qaPlaceholder')}
          // The same keyboard grammar as the chat composer: Cmd/Ctrl+Enter
          // sends, plain Enter keeps making new lines.
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void onSubmit();
            }
          }}
          {...register('question')}
        />
        <div className={styles.formFooter}>
          {/* The chat's own counter key: same cap, same send shortcut, so the
              two composers on this page cannot describe the keyboard
              differently. */}
          <span className={styles.counter} id="advisor-qa-counter">
            {t('advisor.counter', { length: question.length, max: ADVISOR_QUESTION_MAX })}
          </span>
          <span className={styles.spacer} />
          <Button type="submit" variant="primary" disabled={ask.isPending}>
            {t(ask.isPending ? 'advisor.qaAsking' : 'advisor.qaAsk')}
          </Button>
        </div>
        {errors.question ? (
          <p className={styles.fieldError} role="alert">
            {questionErrorMessage(errors.question.type, t)}
          </p>
        ) : null}
      </form>

      {/* ONE alert slot, five distinct sentences (describeQaError): each of the
          three 503s, the unusable answer and the rate limit ask something
          different of the reader. */}
      {failure !== null ? (
        <p className={styles.error} role="alert">
          {failure.message}
        </p>
      ) : null}

      {/* Not streamed (D-Q2), and tens of seconds long: so the wait is SAID, and
          the shape of what is coming is held open with skeleton lines instead of
          a dead screen. */}
      {ask.isPending ? (
        <div className={styles.pending}>
          <p className={styles.pendingLabel} role="status">
            {t('advisor.qaAsking')}
          </p>
          <div className={styles.skeletonLine} aria-hidden="true" />
          <div className={styles.skeletonLine} aria-hidden="true" />
          <div className={styles.skeletonLineShort} aria-hidden="true" />
        </div>
      ) : null}

      {/* Visually hidden, announced once per finished answer — the global
          `srOnly` helper, not a second copy of it. */}
      <p className="srOnly" role="status">
        {announcement}
      </p>

      {answer === undefined ? (
        // The idle arm, and ONLY when the screen is idle: while a question is in
        // flight the skeleton above holds the space, and after a failure (TC-12)
        // the alert above is the whole answer — offering example questions under
        // "too many questions, wait a minute" would read as advice to ask more.
        ask.isPending || failure !== null ? null : (
          <EmptyState
            title={t('advisor.qaEmptyTitle')}
            description={t('advisor.qaEmptyBody')}
            actions={
              <ul className={styles.exampleList}>
                {EXAMPLE_KEYS.map((key) => {
                  const example = t(key);
                  return (
                    <li key={key}>
                      <Button
                        size="sm"
                        className={styles.example}
                        onClick={() => fillExample(example)}
                      >
                        {example}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            }
          />
        )
      ) : answer.answer === null ? (
        // ASK-4: `answer: null` ⇔ `retrieved_count == 0`, and then the server
        // made NO model call at all. Not an error, and not an empty frame: the
        // copy says there is no answer and what to try instead. No total either
        // — three zeros about nothing (the /debts empty-summary rule).
        <EmptyState title={t('advisor.qaNoResults')} description={t('advisor.qaNoResultsCta')} />
      ) : (
        <div className={styles.answer}>
          <h3 className={styles.answerTitle}>{t('advisor.qaAnswerLabel')}</h3>
          {/* VERBATIM. Plain text, pre-wrapped, React-escaped; the model's own
              language, never this screen's. */}
          <p className={styles.answerText}>{answer.answer}</p>

          <h3 className={styles.citationsTitle}>
            {t('advisor.qaCitations', {
              count: answer.citations.length,
              retrieved: answer.retrieved_count,
            })}
          </h3>
          {answer.citations.length === 0 ? (
            // The other half of ASK-4: a NON-null answer with ZERO citations is
            // reachable and is NOT the nothing-found arm — the model answered
            // without leaning on any single row. Said as a fact, with the
            // heading above already reading "0 of N found".
            <p className={styles.note}>
              {t('advisor.qaRetrieved', { count: answer.retrieved_count })}
            </p>
          ) : (
            <ul className={styles.citations}>
              {answer.citations.map((hit) => (
                <li key={hit.transaction.id}>
                  <QaCitation
                    hit={hit}
                    categoryIndex={categoryIndex}
                    // ASK-3: the total is over the RETRIEVED set and its currency
                    // IS the profile base — so the citation's "≈" line is judged
                    // against the server's own answer, not a second read.
                    baseCurrency={answer.total.currency}
                  />
                </li>
              ))}
            </ul>
          )}

          {/* Rendered even when the answer quotes a figure in words: the
              server's number is the only sum the user may trust (ASK-3), and
              this screen sums nothing. */}
          <SearchTotals total={answer.total} label={t('advisor.qaTotalLabel')} />

          {/* The groundedness metric — references the verifier refused to trust
              (D-Q5). News, so `role="status"`; text, never a tooltip, because it
              is what decides whether the prompt has to change. */}
          {answer.dropped_citations > 0 ? (
            <p className={styles.dropped} role="status">
              {t('advisor.qaDropped', { count: answer.dropped_citations })}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
