import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';

import { AppModule } from './app.module';
import { config } from './config';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Behind a load balancer the client address is the first entry of
      // X-Forwarded-For. Without this, every audit row records the balancer.
      trustProxy: true,
      bodyLimit: 30 * 1024 * 1024,
    }),
    { bufferLogs: true },
  );

  await app.register(fastifyCookie);

  app.setGlobalPrefix('v1');

  app.enableCors({
    origin: config.corsOrigins,
    // Sessions are cookies, so the browser has to be allowed to send them.
    credentials: true,
    allowedHeaders: ['Content-Type', 'If-Match', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });

  // No global ValidationPipe. Request bodies are parsed by the Zod schemas in
  // @emr/contracts, which the web app compiles against too — so the rule the
  // browser enforces and the rule the server enforces are the same object, and
  // cannot drift. A second, decorator-driven validation layer would only add a
  // way for them to disagree.
  app.enableShutdownHooks();

  await app.listen(config.PORT, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`API listening on :${config.PORT} (${config.NODE_ENV})`);
  logger.log(`Storage driver: ${config.STORAGE_DRIVER}`);
}

bootstrap().catch((error) => {
  // console, not the Nest logger: the failure may be that the logger never got
  // built. This is the last thing the process does.
  console.error('The API failed to start:', error);
  process.exit(1);
});
