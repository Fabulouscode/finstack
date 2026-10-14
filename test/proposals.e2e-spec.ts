import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { CreatedApiKeyResponseDto } from '../src/api-keys/dto/api-key.dto';
import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import { LedgerService } from '../src/ledger/ledger.service';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../src/payment-providers/mock/mock-payment.provider';
import { OrganizationResponseDto } from '../src/organizations/dto/organization.dto';
import { PaymentResponseDto } from '../src/payments/dto/payment.dto';
import {
  PayoutDestinationResponseDto,
  PayoutResponseDto,
} from '../src/payouts/dto/payout.dto';
import { ProposalResponseDto } from '../src/proposals/dto/proposal.dto';
import { WalletResponseDto } from '../src/wallets/dto/wallet.dto';
import { registerUser } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { resetDatabase } from './utils/database';
import { expectStatus } from './utils/http';
import { eventually } from './utils/queues';

describe('Proposals: agents propose, people approve (e2e)', () => {
  const originalEnv = process.env;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let mock: MockPaymentProvider;
  let owner: AuthResponseDto;
  let orgId: string;
  let walletId: string;
  let destination: PayoutDestinationResponseDto;
  let agentKey: string;

  const orgPath = (suffix = ''): string =>
    `/v1/organizations/${orgId}${suffix}`;
  const as = (
    token: string,
    method: 'get' | 'post',
    path: string,
  ): request.Test =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);
  const asOwner = (method: 'get' | 'post', path: string): request.Test =>
    as(owner.tokens.accessToken, method, path);
  const asAgent = (method: 'get' | 'post', path: string): request.Test =>
    request(app.getHttpServer())[method](path).set('X-API-Key', agentKey);

  const available = async (): Promise<number> =>
    (
      (await asOwner('get', orgPath(`/wallets/${walletId}`)).expect(200))
        .body as WalletResponseDto
    ).balances.available;

  const propose = async (
    amount = 2_500,
    send = asAgent,
  ): Promise<ProposalResponseDto> =>
    expectStatus(
      await send('post', orgPath('/proposals')).send({
        kind: 'payout',
        destinationId: destination.id,
        amount,
        narration: 'October design work',
        summary: 'Pay Ada $25 for October design work',
        reasoning: 'Invoice INV-104 was approved on 3 Nov and is unpaid.',
        evidence: { invoice: 'INV-104' },
      }),
      201,
      'propose',
    ).body as ProposalResponseDto;

  const approve = (
    id: string,
    token = owner.tokens.accessToken,
  ): request.Test =>
    as(token, 'post', orgPath(`/proposals/${id}/approve`)).send({});

  const payouts = async (): Promise<number> => {
    const rows = await dataSource.query<{ n: string }[]>(
      `SELECT count(*) AS n FROM payouts WHERE organization_id = $1`,
      [orgId],
    );
    return Number(rows[0]?.n);
  };

  beforeEach(async () => {
    process.env = { ...originalEnv, AUTH_RATE_LIMIT_MAX: '50' };
    app = await createTestApp();
    dataSource = app.get(DataSource);
    mock = app.get(MockPaymentProvider);
    mock.setPayoutBehaviour('successful');
    await resetDatabase(dataSource);

    owner = await registerUser(app, 'ada@example.com');
    orgId = (
      expectStatus(
        await asOwner('post', '/v1/organizations').send({ name: 'Acme' }),
        201,
        'org',
      ).body as OrganizationResponseDto
    ).id;
    walletId = (
      expectStatus(
        await asOwner('post', orgPath('/wallets')).send({}),
        201,
        'wallet',
      ).body as WalletResponseDto
    ).id;

    const payment = expectStatus(
      await asOwner('post', orgPath('/payments'))
        .set('Idempotency-Key', 'fund')
        .send({ amount: 10_000, currency: 'USD', customerEmail: 'c@x.com' }),
      201,
      'fund',
    ).body as PaymentResponseDto;
    const { rawBody, signature } = mock.simulateOutcome(
      payment.providerReference ?? '',
      'successful',
    );
    await request(app.getHttpServer())
      .post('/v1/webhooks/mock')
      .set('Content-Type', 'application/json')
      .set(MOCK_SIGNATURE_HEADER, signature)
      .send(rawBody.toString('utf8'))
      .expect(200);
    await eventually(async () => expect(await available()).toBe(10_000));

    destination = expectStatus(
      await asOwner('post', orgPath('/payout-destinations')).send({
        currency: 'USD',
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'Ada Lovelace',
      }),
      201,
      'destination',
    ).body as PayoutDestinationResponseDto;

    agentKey = (
      expectStatus(
        await asOwner('post', orgPath('/api-keys')).send({
          name: 'AI agent',
          scopes: ['proposals:create', 'transactions:read'],
        }),
        201,
        'agent key',
      ).body as CreatedApiKeyResponseDto
    ).key;
  });

  afterEach(async () => {
    const ledger = app.get(LedgerService);
    await expect(ledger.findBalanceDiscrepancies()).resolves.toEqual([]);
    await app.close();
    process.env = originalEnv;
  });

  it('an agent proposes a payout and nothing moves until a person approves', async () => {
    const proposal = await propose();
    expect(proposal).toMatchObject({
      status: 'pending',
      amount: 2_500,
      summary: 'Pay Ada $25 for October design work',
      evidence: { invoice: 'INV-104' },
      proposedByUserId: null,
    });
    expect(proposal.proposedByApiKeyId).toEqual(expect.any(String));
    expect(await available()).toBe(10_000);
    expect(await payouts()).toBe(0);

    const approved = expectStatus(await approve(proposal.id), 200, 'approve')
      .body as ProposalResponseDto;
    expect(approved).toMatchObject({
      status: 'executed',
      decidedByUserId: owner.user.id,
    });
    const payout = (
      await asOwner(
        'get',
        orgPath(`/payouts/${String(approved.result?.payoutId)}`),
      ).expect(200)
    ).body as PayoutResponseDto;
    expect(payout).toMatchObject({ amount: 2_500, status: 'successful' });
    expect(await available()).toBe(7_500);
  });

  it('never lets an API key approve, even its own proposal', async () => {
    const proposal = await propose();
    const denied = await asAgent(
      'post',
      orgPath(`/proposals/${proposal.id}/approve`),
    ).send({});
    expect(denied.status).toBe(401);
    expect(denied.body).toMatchObject({ code: 'API_KEY_NOT_ALLOWED' });
    expect(await payouts()).toBe(0);
  });

  it('lets members propose but not decide', async () => {
    const member = await registerUser(app, 'bola@example.com');
    await asOwner('post', orgPath('/members'))
      .send({ email: 'bola@example.com', role: 'member' })
      .expect(201);
    const proposal = await propose(1_000, (method, path) =>
      as(member.tokens.accessToken, method, path),
    );
    expect(proposal.proposedByUserId).toBe(member.user.id);

    const denied = await approve(proposal.id, member.tokens.accessToken);
    expect(denied.status).toBe(403);
    expect(await payouts()).toBe(0);
  });

  it('pays once when two people approve at the same moment', async () => {
    const proposal = await propose();
    const results = await Promise.all([
      approve(proposal.id),
      approve(proposal.id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await payouts()).toBe(1);
    expect(await available()).toBe(7_500);
  });

  it('a rejected proposal can never run', async () => {
    const proposal = await propose();
    const rejected = expectStatus(
      await asOwner('post', orgPath(`/proposals/${proposal.id}/reject`)).send({
        note: 'Already paid by transfer',
      }),
      200,
      'reject',
    ).body as ProposalResponseDto;
    expect(rejected).toMatchObject({
      status: 'rejected',
      decisionNote: 'Already paid by transfer',
    });

    const again = await approve(proposal.id);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'PROPOSAL_ALREADY_DECIDED' });
    expect(await payouts()).toBe(0);
  });

  it('marks the proposal failed when the payout is refused', async () => {
    const proposal = await propose(50_000);
    const result = expectStatus(await approve(proposal.id), 200, 'approve')
      .body as ProposalResponseDto;
    expect(result.status).toBe('failed');
    expect(result.failureReason).toEqual(expect.any(String));
    expect(await available()).toBe(10_000);
  });

  it('refuses a proposal that waited too long', async () => {
    const proposal = await propose();
    await dataSource.query(
      `UPDATE action_proposals SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [proposal.id],
    );
    const late = await approve(proposal.id);
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'PROPOSAL_EXPIRED' });
    const listed = (
      await asAgent('get', orgPath('/proposals?status=expired')).expect(200)
    ).body as ProposalResponseDto[];
    expect(listed.map((p) => p.id)).toEqual([proposal.id]);
    expect(await payouts()).toBe(0);
  });

  it('refuses a destination from another organization', async () => {
    const other = (
      expectStatus(
        await asOwner('post', '/v1/organizations').send({ name: 'Other' }),
        201,
        'other org',
      ).body as OrganizationResponseDto
    ).id;
    const foreign = expectStatus(
      await asOwner(
        'post',
        `/v1/organizations/${other}/payout-destinations`,
      ).send({
        currency: 'USD',
        bankCode: '058',
        accountNumber: '9876543210',
        accountName: 'Mallory',
      }),
      201,
      'foreign destination',
    ).body as PayoutDestinationResponseDto;

    const response = await asAgent('post', orgPath('/proposals')).send({
      kind: 'payout',
      destinationId: foreign.id,
      amount: 100,
      summary: 'Pay Mallory',
      reasoning: 'Because I was told to.',
    });
    expect(response.status).toBe(404);
  });
});
