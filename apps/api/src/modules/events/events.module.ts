import { Controller, Get, Module, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Authenticated } from '../../common/http/decorators';
import { SkipAudit } from '../../common/audit/audit.interceptor';
import { EventHub } from '../../common/events/event-hub.service';
import { TenantContext } from '../../common/tenancy/tenant-context';

/**
 * The live update stream.
 *
 * Server-Sent Events rather than WebSockets. Everything here travels one way —
 * server to browser — and SSE gets reconnection, event ids and plain HTTP
 * semantics for free, which means it passes through the Next BFF, a load
 * balancer and a corporate proxy without any of them needing to know about it.
 * A WebSocket would need all of that arranged and would buy nothing, because
 * the browser never pushes on this channel; it POSTs like everything else.
 *
 * AUTHENTICATED, NOT PUBLIC. EventSource cannot set headers, which is why many
 * implementations end up putting a token in the query string. This one does not
 * have to: the session is an httpOnly cookie and the browser sends it on the
 * stream request like any other. No credential ever reaches an access log.
 *
 * The clinic comes from the verified session. That is what makes the hub's
 * filter a boundary rather than a suggestion.
 */
@Controller('events')
export class EventsController {
  constructor(private readonly hub: EventHub) {}

  /**
   * Opens the stream. Held until the client disconnects.
   *
   * Audit is skipped deliberately: this connection is opened once per tab and
   * lives for hours, so auditing it records that someone had a browser open —
   * which is noise in a trail whose value is that everything in it is an action
   * someone took. The reads it triggers are audited individually, where the
   * evidence actually is.
   */
  @Authenticated()
  @SkipAudit()
  @Get()
  stream(@Res() reply: FastifyReply): void {
    const ctx = TenantContext.require();
    const raw = reply.raw;

    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers proxied responses by default, which holds every event
      // until the buffer fills — so a live stream arrives in silent bursts
      // minutes apart, and looks exactly like a broken feature.
      'x-accel-buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      // If the socket has gone, writing throws and would take the process with
      // it on an unhandled error. A disconnected browser is the normal case.
      try {
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        cleanup();
      }
    };

    // Named event, not a bare comment. The browser uses it to confirm the
    // stream actually opened — EventSource cannot read a response status, so
    // "connected" is otherwise indistinguishable from "hanging".
    send('hello', { clinicId: ctx.clinicId, at: new Date().toISOString() });

    const unsubscribe = this.hub.subscribe(ctx.clinicId, (event) => {
      send(event.type, event.data);
    });

    /*
     * A heartbeat every 25 seconds.
     *
     * Proxies and load balancers close connections that have been idle for 30
     * to 60 seconds, and a quiet clinic is idle for hours. Without this the
     * stream drops and silently reconnects all day; with it the connection is
     * never idle long enough to be reaped.
     */
    const heartbeat = setInterval(() => send('heartbeat', { at: Date.now() }), 25_000);
    // Do not hold the process open at shutdown for a timer whose only job is to
    // keep a socket warm.
    heartbeat.unref?.();

    let closed = false;
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    }

    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
  }
}

@Module({
  controllers: [EventsController],
})
export class EventsModule {}
