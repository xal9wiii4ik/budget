import { describe, expect, it } from 'vitest';

import { ALLOWLIST } from './allowlist.js';
import { loadOpenApiDocument } from './openapi.js';
import { buildTools, toolsForScope } from './tools.js';

/**
 * Drift guard against the REAL contract: if an endpoint is renamed, a parameter
 * disappears or a body property starts colliding with a path parameter, this
 * test goes red here instead of the MCP server refusing to start on a user's
 * machine. It is the reason `@budget/mcp-server#test` lists apps/api/openapi.json
 * as a turbo input.
 */
const READ_TOOLS = [
  'list_transactions',
  'get_transactions_summary',
  'list_categories',
  'list_accounts',
  'list_goals',
  'get_goal',
  'get_goal_progress',
  'list_goal_contributions',
  'get_goal_plan',
  'list_upcoming_goal_deadlines',
  'list_limits',
  'list_recurring',
  'list_upcoming_recurring',
  'get_profile',
  'get_stats_summary',
  'get_stats_monthly',
  'get_top_merchants',
  'convert_currency',
];

const WRITE_TOOLS = [
  'create_transaction',
  'update_transaction',
  'delete_transaction',
  'create_category',
  'update_category',
  'create_account',
  'update_account',
  'create_recurring',
  'update_recurring',
  'set_category_limit',
  'create_goal',
  'update_goal',
  'add_goal_contribution',
  'create_goal_item',
  'update_goal_item',
];

describe('ALLOWLIST against apps/api/openapi.json', () => {
  const tools = buildTools(loadOpenApiDocument({}), ALLOWLIST);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  it('builds exactly the 33 curated tools', () => {
    expect(tools.filter((tool) => tool.scope === 'read').map((tool) => tool.name)).toEqual(READ_TOOLS);
    expect(tools.filter((tool) => tool.scope === 'write').map((tool) => tool.name)).toEqual(WRITE_TOOLS);
  });

  it('keeps the arguments the server actually requires', () => {
    expect(byName.get('convert_currency')?.inputSchema.required).toEqual(['amount_minor', 'from', 'to']);
    expect(byName.get('get_transactions_summary')?.inputSchema.required).toEqual(['month']);
    expect(byName.get('get_goal')?.pathParams).toEqual(['goal_id']);
    // account_id joined the required list with the accounts scope; the order is
    // the schema's property order, which is how buildTools walks them.
    // amount_minor LEFT it with the spend-currency scope: sending the original
    // pair alone lets the server derive what the account was charged, so the
    // contract can no longer demand the settlement amount up front. The curated
    // text is what tells the model it is still required when there is no pair.
    expect(byName.get('create_transaction')?.inputSchema.required).toEqual([
      'account_id',
      'kind',
      'occurred_at',
    ]);
    // starting_balance_minor has a default, so the model is never forced to
    // invent an opening balance for a new account.
    expect(byName.get('create_account')?.inputSchema.required).toEqual(['currency', 'name', 'type']);
    // A plan node needs a NAME and nothing else: a grouping node has no price of
    // its own, and the model must never be forced to invent one for it. The day
    // the contract makes amount_minor (or currency, or parent_id) mandatory, the
    // curated "leave it out for a grouping node" prose becomes a lie — here.
    expect(byName.get('create_goal_item')?.inputSchema.required).toEqual(['goal_id', 'name']);
    // The upcoming-deadlines window takes NOTHING: `days` has a default, and a
    // required argument here would make the model invent a horizon instead of
    // asking "what is coming up". The curated text is the only place that says
    // the server computes the dates, so assert it reached the built tool.
    const upcomingGoals = byName.get('list_upcoming_goal_deadlines');
    expect(upcomingGoals?.inputSchema.required ?? []).toEqual([]);
    expect(upcomingGoals?.queryParams).toEqual(['days']);
    expect((upcomingGoals?.inputSchema.properties.days as { description?: string }).description)
      .toContain('1-90');
    // account_id is a FILTER on list_transactions, never mandatory: listing
    // transactions must not force the model to pick an account first. The
    // curated text is what tells it a transfer shows up on both sides, so
    // assert the description survived the build, not just the property.
    const listTransactions = byName.get('list_transactions');
    expect(listTransactions?.inputSchema.required).not.toContain('account_id');
    expect(listTransactions?.queryParams).toContain('account_id');
    expect((listTransactions?.inputSchema.properties.account_id as { description?: string }).description)
      .toContain('list_accounts');
  });

  it('curates every field the model can send on a money write', () => {
    // The flat schema takes whatever the contract has, so a new body field
    // (original_amount_minor/original_currency/country arrived this way, then
    // goal_item_id) reaches the model the moment the API grows it. Without a
    // curated line it arrives with NO text at all: the model would be free to
    // invent what "original" means and which currency its minor units are in.
    // This is the tripwire that says "the contract moved, write the safety
    // prose". The goal-item writes are in it for the same reason — their
    // amounts are money, and `converted_minor` is an override of the server's
    // own conversion.
    expect(Object.keys(byName.get('create_transaction')?.inputSchema.properties ?? {}))
      .toContain('original_amount_minor');
    expect(Object.keys(byName.get('create_goal_item')?.inputSchema.properties ?? {}))
      .toContain('converted_minor');
    for (const name of [
      'create_transaction',
      'update_transaction',
      'create_goal_item',
      'update_goal_item',
    ]) {
      const properties = byName.get(name)?.inputSchema.properties ?? {};
      for (const [property, schema] of Object.entries(properties)) {
        const { description } = schema as { description?: string };
        expect(description ?? '', `${name}.${property} has no curated description`).not.toBe('');
      }
    }
  });

  it('never marks an optional PATCH field as required', () => {
    // Every body field of an update is optional (omit = keep); only the path
    // parameter is mandatory. A normalization bug that promoted a nullable
    // field into `required` would force the model to resend fields it was not
    // asked to change.
    for (const name of [
      'update_transaction',
      'update_category',
      'update_account',
      'update_recurring',
      'update_goal',
      'update_goal_item',
    ]) {
      const tool = byName.get(name);
      expect(tool?.method).toBe('patch');
      expect(tool?.inputSchema.required).toEqual(tool?.pathParams);
    }
  });

  it('keeps client_id out of create_transaction and fills it in the package', () => {
    const create = byName.get('create_transaction');

    // The idempotency key is the package's, not the model's (architecture §6).
    expect(Object.keys(create?.inputSchema.properties ?? {})).not.toContain('client_id');
    expect(create?.bodyProps).not.toContain('client_id');
    expect(create?.managedBody).toEqual({ client_id: 'uuid' });
  });

  it('shows a read token the read tools and nothing else', () => {
    const forRead = toolsForScope(tools, 'read').map((tool) => tool.name);

    expect(forRead).toEqual(READ_TOOLS);
    // delete_transaction in particular is invisible to a read token.
    for (const name of WRITE_TOOLS) expect(forRead).not.toContain(name);
    expect(toolsForScope(tools, 'full')).toHaveLength(33);
  });
});
