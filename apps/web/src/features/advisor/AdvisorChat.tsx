// The advisor panel (4.4 W3). Since the i18n scope its CHROME follows the app's
// language like every other screen; the ANSWER is the model's own text and is
// rendered verbatim (per AM-8 it is PLAIN TEXT, which is why it renders with
// `white-space: pre-wrap` and this scope adds no markdown dependency).
import { zodResolver } from '@hookform/resolvers/zod';
import { ADVISOR_QUESTION_MAX, advisorAskSchema } from '@budget/shared';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Textarea } from '../../components/Field';
import { useT } from '../../i18n/context';
import type { SimpleKey, Translate } from '../../i18n/t';
import { useAdvisorChat, type ChatTurn } from './useAdvisorChat';
import styles from './AdvisorChat.module.css';

// The shared schema (the same one mobile will use at unfreeze) wrapped in the
// one-field object react-hook-form wants. Validation itself is NOT hand-rolled
// here — the trim/blank/2000 rules mirror the server's and live in @budget/shared.
const composerSchema = z.object({ question: advisorAskSchema });
type ComposerInput = z.input<typeof composerSchema>;
type ComposerValues = z.output<typeof composerSchema>;

// Filled into the composer (not sent on click): the user gets to see and edit
// what they are about to ask — so they are UI copy and translated.
const EXAMPLE_KEYS: readonly SimpleKey[] = [
  'advisor.example1',
  'advisor.example2',
  'advisor.example3',
];

function statusNote(turn: ChatTurn, t: Translate): string | null {
  if (turn.status === 'stopped') return t('advisor.stopped');
  return null;
}

// The shared schema's messages are documented DEFAULTS, not a contract (see
// schemas.ts): the panel maps the zod issue CODE — which zodResolver puts in
// `error.type` — onto its own dictionary entry, so validation stays shared while
// the sentence follows the chosen language.
function questionErrorMessage(type: string | undefined, t: Translate): string {
  return type === 'too_big'
    ? t('advisor.questionTooLong', { max: ADVISOR_QUESTION_MAX })
    : t('advisor.questionRequired');
}

export function AdvisorChat() {
  const t = useT();
  const { turns, isStreaming, ask, stop } = useAdvisorChat();

  const {
    register,
    handleSubmit,
    control,
    setValue,
    setFocus,
    reset,
    formState: { errors },
  } = useForm<ComposerInput, unknown, ComposerValues>({
    resolver: zodResolver(composerSchema),
    defaultValues: { question: '' },
  });

  const question = useWatch({ control, name: 'question' });

  const onSubmit = handleSubmit((values) => {
    // One answer at a time: `ask` refuses while a stream is still open and says
    // so by returning false. The composer is cleared ONLY on an accepted send, so
    // a refused Cmd/Ctrl+Enter never eats the question the user just typed.
    if (ask(values.question)) reset({ question: '' });
  });

  const fillExample = (text: string) => {
    setValue('question', text, { shouldValidate: false });
    setFocus('question');
  };

  const lastTurn = turns[turns.length - 1];
  // Derived during render: one polite announcement when an answer lands. The
  // streaming region itself is aria-live="off" (see below).
  const announcement =
    lastTurn?.role === 'assistant' && lastTurn.status === 'complete'
      ? t('advisor.answerReady')
      : null;

  return (
    <div className={styles.chat}>
      {turns.length === 0 ? (
        <EmptyState
          title={t('advisor.emptyTitle')}
          description={t('advisor.emptyBody')}
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
      ) : (
        // aria-live="off" ON PURPOSE: a polite live region re-announced on every
        // token is unusable with a screen reader. Completion is announced once,
        // by the separate role="status" node below.
        <ol className={styles.transcript} aria-live="off">
          {turns.map((turn) => {
            const note = statusNote(turn, t);
            return (
              <li
                key={turn.id}
                className={turn.role === 'user' ? styles.userTurn : styles.assistantTurn}
              >
                <span className={styles.role}>
                  {t(turn.role === 'user' ? 'advisor.you' : 'advisor.assistant')}
                </span>
                {/* Partial text is NEVER thrown away: a stopped or failed answer
                    keeps whatever arrived, with the notice below it. */}
                <p className={styles.text}>{turn.text}</p>
                {turn.status === 'streaming' && turn.text === '' ? (
                  <p className={styles.typing}>{t('advisor.typing')}</p>
                ) : null}
                {turn.failure !== undefined ? (
                  <p
                    className={turn.failure.keepsPartialAnswer ? styles.notice : styles.error}
                    role="alert"
                  >
                    {turn.failure.message}
                  </p>
                ) : null}
                {note !== null ? <p className={styles.notice}>{note}</p> : null}
              </li>
            );
          })}
        </ol>
      )}

      {/* Visually hidden, but announced: one polite message per finished answer.
          The global `srOnly` helper, not a second copy of it. */}
      <p className="srOnly" role="status">
        {announcement}
      </p>

      <form className={styles.composer} onSubmit={onSubmit} noValidate>
        <label className={styles.label} htmlFor="advisor-question">
          {t('advisor.questionLabel')}
        </label>
        <Textarea
          id="advisor-question"
          rows={3}
          maxLength={ADVISOR_QUESTION_MAX}
          aria-invalid={errors.question ? true : undefined}
          aria-describedby="advisor-question-counter"
          placeholder={t('advisor.placeholder')}
          // Cmd/Ctrl+Enter sends; plain Enter keeps making new lines, because a
          // question here is often multi-line.
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void onSubmit();
            }
          }}
          {...register('question')}
        />
        <div className={styles.composerFooter}>
          <span className={styles.counter} id="advisor-question-counter">
            {t('advisor.counter', {
              length: question.length,
              max: ADVISOR_QUESTION_MAX,
            })}
          </span>
          <span className={styles.spacer} />
          {isStreaming ? (
            <Button onClick={stop}>{t('advisor.stop')}</Button>
          ) : null}
          <Button type="submit" variant="primary" disabled={isStreaming}>
            {t(isStreaming ? 'advisor.answering' : 'advisor.ask')}
          </Button>
        </div>
        {errors.question ? (
          <p className={styles.fieldError} role="alert">
            {questionErrorMessage(errors.question.type, t)}
          </p>
        ) : null}
      </form>
    </div>
  );
}
