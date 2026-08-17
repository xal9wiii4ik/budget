// The advisor panel (4.4 W3). RUSSIAN throughout, by grooming ruling R4.2: the
// binding copy is Russian, the model answers in Russian (and, per AM-8, in PLAIN
// TEXT — which is why the answer renders with `white-space: pre-wrap` and this
// scope adds no markdown dependency). No other screen's copy changes.
import { zodResolver } from '@hookform/resolvers/zod';
import { ADVISOR_QUESTION_MAX, advisorAskSchema } from '@budget/shared';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { useAdvisorChat, type ChatTurn } from './useAdvisorChat';
import styles from './AdvisorChat.module.css';

// The shared schema (the same one mobile will use at unfreeze) wrapped in the
// one-field object react-hook-form wants. Validation itself is NOT hand-rolled
// here — the trim/blank/2000 rules mirror the server's and live in @budget/shared.
const composerSchema = z.object({ question: advisorAskSchema });
type ComposerInput = z.input<typeof composerSchema>;
type ComposerValues = z.output<typeof composerSchema>;

// Filled into the composer (not sent on click): the user gets to see and edit
// what they are about to ask.
const EXAMPLES = [
  'Куда уходят мои деньги в этом месяце?',
  'На чём я могу сэкономить?',
  'Как я двигаюсь к своим целям?',
];

function statusNote(turn: ChatTurn): string | null {
  if (turn.status === 'stopped') return 'Вы остановили ответ.';
  return null;
}

// The shared schema's messages are documented DEFAULTS, not a contract (see
// schemas.ts): this panel is Russian, so it maps the zod issue CODE — which
// zodResolver puts in `error.type` — to its own copy instead of shipping an
// English sentence into a Russian conversation. Validation stays shared.
function questionErrorMessage(type: string | undefined): string {
  return type === 'too_big'
    ? `Вопрос должен быть не длиннее ${ADVISOR_QUESTION_MAX} символов.`
    : 'Введите вопрос.';
}

export function AdvisorChat() {
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
    lastTurn?.role === 'assistant' && lastTurn.status === 'complete' ? 'Ответ готов' : null;

  return (
    <div className={styles.chat}>
      {turns.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Спросите про свои траты</p>
          <p className={styles.emptyBody}>
            AI видит ваши категории, суммы за последние месяцы и цели — и отвечает
            обычным текстом. Например:
          </p>
          <ul className={styles.exampleList}>
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  className={styles.example}
                  onClick={() => fillExample(example)}
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        // aria-live="off" ON PURPOSE: a polite live region re-announced on every
        // token is unusable with a screen reader. Completion is announced once,
        // by the separate role="status" node below.
        <ol className={styles.transcript} aria-live="off">
          {turns.map((turn) => {
            const note = statusNote(turn);
            return (
              <li
                key={turn.id}
                className={turn.role === 'user' ? styles.userTurn : styles.assistantTurn}
              >
                <span className={styles.role}>{turn.role === 'user' ? 'Вы' : 'AI'}</span>
                {/* Partial text is NEVER thrown away: a stopped or failed answer
                    keeps whatever arrived, with the notice below it. */}
                <p className={styles.text}>{turn.text}</p>
                {turn.status === 'streaming' && turn.text === '' ? (
                  <p className={styles.typing}>AI печатает…</p>
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

      <p className={styles.announcer} role="status">
        {announcement}
      </p>

      <form className={styles.composer} onSubmit={onSubmit} noValidate>
        <label className={styles.label} htmlFor="advisor-question">
          Вопрос
        </label>
        <textarea
          id="advisor-question"
          className={errors.question ? `${styles.input} ${styles.inputError}` : styles.input}
          rows={3}
          maxLength={ADVISOR_QUESTION_MAX}
          aria-invalid={errors.question ? true : undefined}
          aria-describedby="advisor-question-counter"
          placeholder="Например: сколько я потратил на еду в июле?"
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
            {question.length} / {ADVISOR_QUESTION_MAX} · Cmd/Ctrl+Enter — отправить
          </span>
          <span className={styles.spacer} />
          {isStreaming ? (
            <button type="button" className={styles.stop} onClick={stop}>
              Остановить
            </button>
          ) : null}
          <button type="submit" className={styles.submit} disabled={isStreaming}>
            {isStreaming ? 'Отвечает…' : 'Спросить'}
          </button>
        </div>
        {errors.question ? (
          <p className={styles.fieldError} role="alert">
            {questionErrorMessage(errors.question.type)}
          </p>
        ) : null}
      </form>
    </div>
  );
}
