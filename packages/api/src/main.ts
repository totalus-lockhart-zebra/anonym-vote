import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { FaucetConfig } from './config/faucet.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(FaucetConfig);

  app.enableCors({
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(config.port);
  new Logger('bootstrap').log(`anon-vote faucet listening on :${config.port}`);
}

void bootstrap();
