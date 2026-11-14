import { describe, expect, it } from 'vitest';
import {
  inspectOpenApi,
  inspectProtobuf,
  parseOpenApi,
  parseProtobuf
} from '../../src/core/parser/contracts.js';
import { chunkCode } from '../../src/core/chunker/code-chunker.js';

const proto = `syntax = "proto3";
package payments.v1;
// service False { rpc Bogus (Request) returns (Response); }
message Request { string note = 1; }
message Response { string status = 1; }
service Checkout {
  rpc Create (.payments.v1.Request) returns (Response);
  rpc Updates (stream Request) returns (stream Response) {
    option deprecated = true;
  }
}
service Worker { rpc Run (Request) returns (Response); }
`;
describe('contract inspection and indexing', () => {
  it('extracts exact OpenAPI methods, paths, parameter evidence and schemas from JSON', () => {
    const source = JSON.stringify({
      openapi: '3.1.0',
      paths: {
        '/checkout': {
          parameters: [{ name: 'tenant', in: 'header' }],
          post: {
            operationId: 'createCheckout',
            requestBody: { $ref: './request.yaml' },
            responses: { '200': { description: 'Created' } }
          }
        }
      },
      components: { schemas: { PaymentStatus: { type: 'string', enum: ['paid', 'pending'] } } }
    });
    const result = inspectOpenApi(source)!;
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      id: 'createCheckout',
      method: 'POST',
      path: '/checkout',
      request: { $ref: './request.yaml' }
    });
    expect(result.schemas.PaymentStatus).toMatchObject({ type: 'string' });
    const chunks = chunkCode(parseOpenApi('api.json', source)!, { layer: 'repo' });
    expect(
      chunks.some(
        (chunk) =>
          chunk.symbolName === 'POST /checkout (createCheckout)' &&
          chunk.content.includes('request.yaml')
      )
    ).toBe(true);
  });
  it('supports YAML and Swagger 2 without inventing missing operation IDs', () => {
    const result = inspectOpenApi(
      'swagger: "2.0"\npaths:\n  /status:\n    get:\n      responses:\n        "200":\n          description: OK\ndefinitions:\n  Status:\n    type: string\n'
    )!;
    expect(result.operations[0]).toMatchObject({ id: 'GET /status', path: '/status' });
    expect(result.schemas).toHaveProperty('Status');
  });
  it('rejects malformed, duplicate-key, cyclic or excessively expanded contracts', () => {
    expect(() => inspectOpenApi('openapi: 3.1.0\npaths: {}\npaths: {}')).toThrow();
    expect(() => inspectOpenApi('openapi: 3.1.0\npaths: {}\ncycle: &cycle [*cycle]')).toThrow(
      'Cyclic'
    );
    expect(() => inspectOpenApi('openapi: 3.1.0')).toThrow('paths');
    expect(() => inspectOpenApi('x'.repeat(2 * 1024 * 1024 + 1))).toThrow('2 MiB');
    const big = { openapi: '3.1.0', paths: {}, repeated: Array(21000).fill(1) };
    expect(() => inspectOpenApi(JSON.stringify(big))).toThrow('limits');
  });
  it('leaves ordinary configuration files to the established parser', () => {
    expect(parseOpenApi('config.json', '{"port":3000}')).toBeNull();
    expect(inspectOpenApi('openapi: false\npaths: {}')).toBeNull();
  });
  it('parses qualified gRPC operations, streaming flags and true source line ranges', () => {
    const result = inspectProtobuf(proto);
    expect(result.operations.map((operation) => operation.id)).toEqual([
      '/payments.v1.Checkout/Create',
      '/payments.v1.Checkout/Updates',
      '/payments.v1.Worker/Run'
    ]);
    expect(result.operations[0]).toMatchObject({
      request: '.payments.v1.Request',
      response: 'Response',
      clientStreaming: false,
      serverStreaming: false
    });
    expect(result.operations[1]).toMatchObject({ clientStreaming: true, serverStreaming: true });
    const chunks = chunkCode(parseProtobuf('checkout.proto', proto), { layer: 'repo' });
    const operation = chunks.find((chunk) => chunk.symbolName === '/payments.v1.Checkout/Create')!;
    expect(operation.content).toContain('rpc Create');
    expect(proto.split('\n')[operation.startLine! - 1]).toContain('rpc Create');
  });
  it('does not parse comment, string or nested-option text as RPC declarations', () => {
    const result = inspectProtobuf(
      '/* service Fake { rpc Wrong (X) returns (Y); } */\noption note = "service Fake { rpc Wrong (X) returns (Y); }";\nservice Real { option (x) = { rpc: "not a method" }; rpc Run (X) returns (Y); }'
    );
    expect(result.operations.map((operation) => operation.id)).toEqual(['/Real/Run']);
  });
  it('rejects incomplete RPC signatures and service definitions', () => {
    expect(() => inspectProtobuf('service Api { rpc Run (X) returns (')).toThrow('Malformed');
    expect(() => inspectProtobuf('service Api { rpc Run (X) returns (Y);')).toThrow('Unclosed');
  });
});
