import { ModuleMetadata } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '../../src/config/config.module';
import { DatabaseModule } from '../../src/database/database.module';

/** Compiles the given modules on top of real config and database wiring. */
export function createTestModule(
  imports: NonNullable<ModuleMetadata['imports']>,
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [ConfigModule, DatabaseModule, ...imports],
  }).compile();
}
