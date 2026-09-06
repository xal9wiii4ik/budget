// Moved to `@budget/api-client` (mobile-catchup-3, line C): the mobile plan
// screen builds the SAME tree out of the same flat response, and one definition
// of "order and nesting" is the whole point of the module. This file is a
// RE-EXPORT so every import site here keeps its path — nothing else changed.
export { buildTree, subtreeSize, descendantCount, descendantIds } from '@budget/api-client';
export type { PlanNode, PlanTree } from '@budget/api-client';
