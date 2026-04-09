import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FaucetModule } from './faucet/faucet.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    FaucetModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
