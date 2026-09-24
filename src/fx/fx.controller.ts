import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequestValidationException } from '../common/http/app.exception';
import { toMinorUnits } from '../common/money/money';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { UserRole } from '../users/user.entity';
import { AdminRateProvider } from './admin-rate.provider';
import {
  CreateFxQuoteRequestDto,
  FxQuoteResponseDto,
  FxRateResponseDto,
  SetFxRateRequestDto,
} from './dto/fx.dto';
import { SameCurrencyConversionException } from './fx.errors';
import { FxService } from './fx.service';

@ApiTags('FX')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@ApiProblemResponse(401, 'UNAUTHENTICATED: missing or invalid access token')
@Controller('fx')
export class FxController {
  constructor(
    private readonly fx: FxService,
    private readonly adminRates: AdminRateProvider,
  ) {}

  @Get('rates')
  @ApiOperation({
    summary: 'Current exchange rates',
    description: 'Newest rate of every configured pair.',
  })
  @ApiOkResponse({ type: [FxRateResponseDto] })
  async listRates(): Promise<FxRateResponseDto[]> {
    return (await this.adminRates.listCurrent()).map((rate) =>
      FxRateResponseDto.from(rate),
    );
  }

  @Post('rates')
  @Roles(UserRole.Admin)
  @ApiOperation({
    summary: 'Set an exchange rate (admin)',
    description:
      'Records a new rate for the pair. History is kept; the newest rate wins. Existing quotes keep the rate they locked.',
  })
  @ApiCreatedResponse({ type: FxRateResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(403, 'FORBIDDEN: admin role required')
  @ApiProblemResponse(422, 'SAME_CURRENCY: base and quote must differ')
  async setRate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SetFxRateRequestDto,
  ): Promise<FxRateResponseDto> {
    if (body.base === body.quote) {
      throw new SameCurrencyConversionException();
    }
    return FxRateResponseDto.from(
      await this.adminRates.setRate({ ...body, userId: user.id }),
    );
  }

  @Post('quotes')
  @ApiOperation({
    summary: 'Get a conversion quote',
    description:
      'Locks the current rate (minus the platform spread) for a limited time. Give either the amount to pay (`sourceAmount`) or the amount to receive (`targetAmount`). ' +
      'Credited amounts are rounded down and charged amounts rounded up.',
  })
  @ApiCreatedResponse({ type: FxQuoteResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(
    422,
    'FX_RATE_UNAVAILABLE | SAME_CURRENCY | AMOUNT_TOO_SMALL',
  )
  @ApiProblemResponse(503, 'FX_RATE_STALE: the rate is too old to quote on')
  async createQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateFxQuoteRequestDto,
  ): Promise<FxQuoteResponseDto> {
    if (
      (body.sourceAmount === undefined) ===
      (body.targetAmount === undefined)
    ) {
      throw new RequestValidationException([
        {
          field: 'sourceAmount',
          messages: ['provide exactly one of sourceAmount or targetAmount'],
        },
      ]);
    }

    const base = {
      userId: user.id,
      sourceCurrency: body.sourceCurrency,
      targetCurrency: body.targetCurrency,
    };
    const quote =
      body.sourceAmount !== undefined
        ? await this.fx.createQuote({
            ...base,
            sourceAmount: toMinorUnits(body.sourceAmount),
          })
        : await this.fx.createQuote({
            ...base,
            targetAmount: toMinorUnits(body.targetAmount ?? 0),
          });
    return FxQuoteResponseDto.from(quote);
  }

  @Get('quotes/:quoteId')
  @ApiOperation({ summary: 'Get one of my quotes' })
  @ApiOkResponse({ type: FxQuoteResponseDto })
  @ApiProblemResponse(404, 'FX_QUOTE_NOT_FOUND')
  async getQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('quoteId', ParseUUIDPipe) quoteId: string,
  ): Promise<FxQuoteResponseDto> {
    return FxQuoteResponseDto.from(await this.fx.getQuote(quoteId, user.id));
  }
}
