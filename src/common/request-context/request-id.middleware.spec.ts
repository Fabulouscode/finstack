import { Request, Response } from 'express';
import { RequestContext } from './request-context';
import {
  REQUEST_ID_HEADER,
  requestIdMiddleware,
  resolveRequestId,
  resolveTraceId,
} from './request-id.middleware';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it.each(['abc-123', 'req_01H:xyz.9', 'a'.repeat(128)])(
    'keeps a well-formed inbound id (%s)',
    (id) => {
      expect(resolveRequestId(id)).toBe(id);
    },
  );

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'a'.repeat(129)],
    ['header injection', 'abc\r\nSet-Cookie: x=1'],
    ['log injection', 'abc def'],
  ])('generates a UUID when the inbound id is %s', (_label, id) => {
    expect(resolveRequestId(id)).toMatch(UUID);
  });
});

describe('requestIdMiddleware', () => {
  it('sets the response header and exposes the id to downstream code', () => {
    const req = {
      header: jest.fn().mockReturnValue('inbound-id'),
    } as unknown as Request;
    const setHeader = jest.fn();
    const res = { setHeader } as unknown as Response;
    let seenInContext: string | undefined;

    requestIdMiddleware(req, res, () => {
      seenInContext = RequestContext.requestId();
    });

    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, 'inbound-id');
    expect(seenInContext).toBe('inbound-id');
    expect(RequestContext.requestId()).toBeUndefined();
  });
});

describe('resolveTraceId', () => {
  it('uses the trace id of a valid traceparent', () => {
    expect(
      resolveTraceId('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
    ).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it.each([
    undefined,
    'garbage',
    '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
  ])('starts a new trace for %s', (header) => {
    expect(resolveTraceId(header)).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveTraceId(header)).not.toBe('0'.repeat(32));
  });
});
