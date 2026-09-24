import { ArgumentMetadata } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsPositive, Matches, ValidateNested } from 'class-validator';
import { RequestValidationException } from './app.exception';
import { createValidationPipe } from './validation';

class DestinationDto {
  @IsInt()
  @IsPositive()
  accountId: number;
}

class TransferDto {
  @IsInt()
  @IsPositive()
  amount: number;

  @Matches(/^[A-Z]{3}$/)
  currency: string;

  @ValidateNested()
  @Type(() => DestinationDto)
  destination: DestinationDto;
}

const metadata: ArgumentMetadata = { type: 'body', metatype: TransferDto };

async function validate(body: unknown): Promise<unknown> {
  return createValidationPipe().transform(body, metadata);
}

async function fieldErrors(body: unknown): Promise<string[]> {
  try {
    await validate(body);
  } catch (error) {
    if (error instanceof RequestValidationException) {
      return (error.errors ?? []).map((e) => e.field);
    }
    throw error;
  }
  throw new Error('expected validation to fail');
}

describe('createValidationPipe', () => {
  const valid = {
    amount: 150000,
    currency: 'NGN',
    destination: { accountId: 7 },
  };

  it('returns a DTO instance for a valid body', async () => {
    await expect(validate(valid)).resolves.toBeInstanceOf(TransferDto);
  });

  it('reports nested fields with dotted paths', async () => {
    await expect(
      fieldErrors({ ...valid, destination: { accountId: -1 } }),
    ).resolves.toEqual(['destination.accountId']);
  });

  it('rejects unknown properties instead of silently dropping them', async () => {
    await expect(fieldErrors({ ...valid, isAdmin: true })).resolves.toEqual([
      'isAdmin',
    ]);
  });

  it('never converts types implicitly (a numeric string is not an amount)', async () => {
    await expect(fieldErrors({ ...valid, amount: '150000' })).resolves.toEqual([
      'amount',
    ]);
  });

  it('rejects fractional amounts', async () => {
    await expect(fieldErrors({ ...valid, amount: 1500.5 })).resolves.toEqual([
      'amount',
    ]);
  });

  it('does not echo submitted values in the error', async () => {
    const error = await validate({ ...valid, currency: 'secret-value' }).catch(
      (e: unknown) => e,
    );

    expect(JSON.stringify(error)).not.toContain('secret-value');
  });
});
