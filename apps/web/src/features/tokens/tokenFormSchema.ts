import { z } from 'zod';

/**
 * The create-token form schema.
 *
 * It lives beside the feature rather than in `@budget/shared` (senior-lead
 * ruling, plan-web open question 1): the shared schemas exist because two
 * clients validate the same form, and there is no second consumer here — the
 * mobile client is frozen and has no tokens screen.
 *
 * `name` mirrors the server's `Field(min_length=1, max_length=100)` exactly, so
 * the only way to see a 422 on it is a client bug. It is trimmed, like every
 * other name field in the app, so " " is not a name.
 *
 * `scope` is the generated `PatScope` union spelled as a zod enum. The two are
 * pinned together by `TokenFormValues['scope']` being assigned to the request
 * body's `scope` in TokenFormModal: if the server ever grows a third scope, that
 * assignment still compiles (the enum is a subset) — but a REMOVED scope breaks
 * the build, which is the direction that matters.
 */
export const NAME_MAX = 100;

export const tokenFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: 'Give this token a name so you can tell it apart later.' })
    .max(NAME_MAX, { error: `Name must be ${NAME_MAX} characters or fewer.` }),
  scope: z.enum(['read', 'full']),
});

export type TokenFormValues = z.infer<typeof tokenFormSchema>;
