// Moved to `@budget/api-client` (mobile-catchup-3, line C), beside the other
// patch builders: the mobile item form emits the same diff, and "a cleared
// override is an explicit null" must have one home. A RE-EXPORT so the import
// sites here are untouched; the form's zod schema stays web-local (its messages
// are web dictionary keys).
export { buildGoalItemPatch } from '@budget/api-client';
