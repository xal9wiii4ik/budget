import { describe, expect, it } from 'vitest';

import { buildRequestBody } from './http.js';
import type { BuiltTool } from './tools.js';

/**
 * Only the body-building path is unit-tested here: it is the one place in
 * `http.ts` that INVENTS a value instead of forwarding one, and the value it
 * invents (`client_id`) is what stands between a replayed request and a
 * duplicated transaction.
 */
const tool = (overrides: Partial<BuiltTool>): BuiltTool => ({
  name: 'create_transaction',
  description: '',
  scope: 'write',
  method: 'post',
  path: '/transactions',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  pathParams: [],
  queryParams: [],
  bodyProps: ['amount_minor', 'note'],
  managedBody: { client_id: 'uuid' },
  ...overrides,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('buildRequestBody', () => {
  it('forwards the given arguments, omits the absent ones and stamps a client_id', () => {
    const body = buildRequestBody(tool({}), { amount_minor: 1234 });

    // `note` was not given: omitted, not sent as null — on PATCH that is the
    // difference between "keep it" and "clear it".
    expect(Object.keys(body ?? {})).toEqual(['amount_minor', 'client_id']);
    expect(body?.amount_minor).toBe(1234);
    expect(String(body?.client_id)).toMatch(UUID);
  });

  it('gives every logical call its own client_id', () => {
    const spec = tool({});
    const first = buildRequestBody(spec, { amount_minor: 1 });
    const second = buildRequestBody(spec, { amount_minor: 1 });

    // Two deliberate calls are two transactions; only a REPLAY of one call
    // reuses its id, so the ids must not be shared between calls.
    expect(first?.client_id).not.toBe(second?.client_id);
  });

  it('sends no body at all when the operation has none', () => {
    const remove = tool({ method: 'delete', bodyProps: [], managedBody: {} });

    expect(buildRequestBody(remove, { transaction_id: 'x' })).toBeUndefined();
  });
});
