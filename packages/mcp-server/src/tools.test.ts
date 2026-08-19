import { describe, expect, it } from 'vitest';

import { parseOpenApiDocument, type OpenApiDocument } from './openapi.js';
import { buildTools, ToolBuildError } from './tools.js';
import type { ToolSpec } from './allowlist.js';

/**
 * A hand-written contract, NOT the real one: this file pins generator behaviour
 * (flattening, $ref inlining, null-branch collapse, collision detection), while
 * allowlist.test.ts pins the real contract. Mixing the two would make every
 * backend change rewrite generator tests.
 */
const FIXTURE: OpenApiDocument = parseOpenApiDocument(
  JSON.stringify({
    paths: {
      '/widgets/{widget_id}': {
        get: {
          parameters: [
            { name: 'widget_id', in: 'path', required: true, schema: { format: 'uuid', title: 'Widget Id', type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { default: 50, maximum: 200, minimum: 1, title: 'Limit', type: 'integer' } },
            { name: 'kind', in: 'query', required: false, schema: { anyOf: [{ $ref: '#/components/schemas/Kind' }, { type: 'null' }], title: 'Kind' } },
          ],
        },
        post: {
          parameters: [{ name: 'widget_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/WidgetCreate' } } }, required: true },
        },
      },
      '/collisions/{name}': {
        post: {
          parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/WidgetCreate' } } } },
        },
      },
      '/traced': {
        get: { parameters: [{ name: 'x-trace-id', in: 'header', required: false, schema: { type: 'string' } }] },
      },
    },
    components: {
      schemas: {
        Kind: { description: 'Internal note about the enum.', enum: ['expense', 'income'], title: 'Kind', type: 'string' },
        WidgetCreate: {
          properties: {
            name: { title: 'Name', type: 'string' },
            amount_minor: { minimum: 1, title: 'Amount Minor', type: 'integer' },
            note: { anyOf: [{ type: 'string' }, { type: 'null' }], title: 'Note' },
          },
          required: ['name', 'amount_minor'],
          title: 'WidgetCreate',
          type: 'object',
        },
      },
    },
  }),
  'fixture',
);

const spec = (overrides: Partial<ToolSpec> & Pick<ToolSpec, 'name' | 'method' | 'path'>): ToolSpec => ({
  scope: 'read',
  description: 'fixture tool',
  ...overrides,
});

describe('buildTools', () => {
  it('flattens path and query parameters, drops titles, keeps constraints', () => {
    const [tool] = buildTools(FIXTURE, [
      spec({ name: 'get_widget', method: 'get', path: '/widgets/{widget_id}', params: { limit: 'curated limit text' } }),
    ]);

    expect(tool.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['widget_id'],
      properties: {
        widget_id: { type: 'string', format: 'uuid' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'curated limit text' },
        // anyOf [$ref, null] collapsed: the enum survives, the component's own
        // description does not (it describes the component, not this field).
        kind: { type: 'string', enum: ['expense', 'income'] },
      },
    });
    expect(tool.pathParams).toEqual(['widget_id']);
    expect(tool.queryParams).toEqual(['limit', 'kind']);
    expect(tool.bodyProps).toEqual([]);
  });

  it('inlines the requestBody $ref onto the top level and merges required', () => {
    const [tool] = buildTools(FIXTURE, [spec({ name: 'create_widget', method: 'post', path: '/widgets/{widget_id}' })]);

    expect(Object.keys(tool.inputSchema.properties)).toEqual(['widget_id', 'name', 'amount_minor', 'note']);
    expect(tool.inputSchema.required).toEqual(['widget_id', 'name', 'amount_minor']);
    expect(tool.inputSchema.properties.note).toEqual({ type: 'string' });
    expect(tool.bodyProps).toEqual(['name', 'amount_minor', 'note']);
  });

  it('refuses to flatten a body property onto a parameter of the same name', () => {
    expect(() => buildTools(FIXTURE, [spec({ name: 'collide', method: 'post', path: '/collisions/{name}' })])).toThrow(
      ToolBuildError,
    );
  });

  it('collects every drift instead of stopping at the first one', () => {
    let caught: ToolBuildError | undefined;
    try {
      buildTools(FIXTURE, [
        spec({ name: 'gone', method: 'get', path: '/widgets/removed' }),
        spec({ name: 'traced', method: 'get', path: '/traced' }),
        spec({ name: 'get_widget', method: 'get', path: '/widgets/{widget_id}', params: { colour: 'no such argument' } }),
      ]);
    } catch (error) {
      caught = error as ToolBuildError;
    }

    expect(caught?.errors).toHaveLength(3);
    expect(caught?.errors[0]).toContain('no such path+method');
    expect(caught?.errors[1]).toContain('header');
    expect(caught?.errors[2]).toContain('"colour"');
  });
});
