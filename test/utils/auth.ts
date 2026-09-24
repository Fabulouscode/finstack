import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuthResponseDto } from '../../src/auth/dto/auth.dto';

/** Registers a user through the API and returns the session. */
export async function registerUser(
  app: INestApplication<App>,
  email: string,
): Promise<AuthResponseDto> {
  const response = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: 'correct-horse-battery-staple',
      firstName: 'Test',
      lastName: 'User',
    })
    .expect(201);

  return response.body as AuthResponseDto;
}
