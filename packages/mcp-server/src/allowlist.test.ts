import { describe, expect, it } from 'vitest';

import { ALLOWLIST } from './allowlist.js';
import { loadOpenApiDocument } from './openapi.js';
import { buildTools } from './tools.js';

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

describe('ALLOWLIST against apps/api/openapi.json', () => {
  const tools = buildTools(loadOpenApiDocument({}), ALLOWLIST);

  it('publishes exactly the read tools of architecture §4', () => {
    expect(tools.filter((tool) => tool.scope === 'read').map((tool) => tool.name)).toEqual(READ_TOOLS);
  });

  it('keeps the arguments the server actually requires', () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.get('convert_currency')?.inputSchema.required).toEqual(['amount_minor', 'from', 'to']);
    expect(byName.get('get_transactions_summary')?.inputSchema.required).toEqual(['month']);
    expect(byName.get('get_goal')?.pathParams).toEqual(['goal_id']);
  });
});
