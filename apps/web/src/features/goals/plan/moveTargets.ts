// Moved to `@budget/api-client` (mobile-catchup-3, line C) together with
// `buildTree`, which it walks: the mobile move picker pre-filters by the same
// server rule. A RE-EXPORT so the import sites here are untouched.
export { moveTargets, MAX_PLAN_DEPTH } from '@budget/api-client';
export type { MoveTarget } from '@budget/api-client';
