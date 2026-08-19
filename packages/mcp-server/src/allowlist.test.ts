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
  'list_goals',
  'get_goal',
  'get_goal_progress',
  'list_goal_contributions',
  'list_limits',
  'list_recurring',
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
  'create_recurring',
  'update_recurring',
  'set_category_limit',
  'create_goal',
  'update_goal',
  'add_goal_contribution',
];

describe('ALLOWLIST against apps/api/openapi.json', () => {
  const tools = buildTools(loadOpenApiDocument({}), ALLOWLIST);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  it('builds exactly the 24 tools of architecture §4', () => {
    expect(tools.filter((tool) => tool.scope === 'read').map((tool) => tool.name)).toEqual(READ_TOOLS);
    expect(tools.filter((tool) => tool.scope === 'write').map((tool) => tool.name)).toEqual(WRITE_TOOLS);
  });

  it('keeps the arguments the server actually requires', () => {
    expect(byName.get('convert_currency')?.inputSchema.required).toEqual(['amount_minor', 'from', 'to']);
    expect(byName.get('get_transactions_summary')?.inputSchema.required).toEqual(['month']);
    expect(byName.get('get_goal')?.pathParams).toEqual(['goal_id']);
    expect(byName.get('create_transaction')?.inputSchema.required).toEqual([
      'amount_minor',
      'kind',
      'occurred_at',
    ]);
  });

  it('never marks an optional PATCH field as required', () => {
    // Every body field of an update is optional (omit = keep); only the path
    // parameter is mandatory. A normalization bug that promoted a nullable
    // field into `required` would force the model to resend fields it was not
    // asked to change.
    for (const name of ['update_transaction', 'update_category', 'update_recurring', 'update_goal']) {
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
    expect(toolsForScope(tools, 'full')).toHaveLength(24);
  });
});
