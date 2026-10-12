// Reading the DEBT fields that live on types the contract already owns:
// `debt_id` on a transaction row, and `debt_movements_kept` on a statement
// replace preview.
//
// Both are declared OPTIONAL on the parameter types below, which is doing real
// work rather than being lax. The generated types describe the server we build
// against, not the one actually answering: a field absent from the JSON reads
// here as "this API does not carry debts" instead of `undefined` leaking into a
// badge or a figure. For the replace preview that is the honest answer against an
// older deployment, and the accessor is the ONE place that decides it.
//
// Each parameter also names ONE field the caller certainly has. That is not
// decoration: a type whose every member is optional is a WEAK type, and TS
// refuses an argument that shares no property with it at all (TS2559). The
// required member is what keeps these signatures honest.
//
// These are accessors, not business rules: no money, no dates, no decisions.

/**
 * The debt a transaction row belongs to, or `null` for an ordinary row.
 *
 * A row with a `debt_id` is a debt MOVEMENT: the server refuses to PATCH or
 * DELETE it through `/transactions` (422 `DEBT_MOVEMENT_READONLY`), so the list
 * must send the user to /debts instead of opening a form — this is the predicate
 * that decides it.
 */
export function debtIdOf(transaction: {
  id: string;
  debt_id?: string | null;
}): string | null {
  return transaction.debt_id ?? null;
}

/**
 * How many debt movements a statement REPLACE would spare, or `null` when the
 * server did not report the figure at all (an API that predates the field).
 *
 * `null` is not zero and must not render as one: zero is a promise that nothing
 * was spared, which an older server never made.
 */
export function debtMovementsKept(preview: {
  transfers_kept: number;
  debt_movements_kept?: number | null;
}): number | null {
  return preview.debt_movements_kept ?? null;
}
