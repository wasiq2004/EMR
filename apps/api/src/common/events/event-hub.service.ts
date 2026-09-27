import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { config } from '../../config';

/**
 * The real-time event bus behind the live inbox.
 *
 * TENANCY IS THE WHOLE DESIGN. Every event carries the clinic it belongs to,
 * and a subscriber only ever receives its own clinic's. This is not a
 * convenience filter — an SSE stream is a long-lived pipe out of the server, and
 * a bug here would push one clinic's activity into another clinic's browser
 * without any query ever crossing a row-level security policy.
 *
 * SO THE PAYLOAD CARRIES NO CLINICAL CONTENT. An event says "conversation X
 * changed", never what was said. The browser then fetches through the ordinary
 * authenticated, RLS-scoped endpoints. That means a delivery bug leaks an
 * identifier at worst, and a recipient who cannot fetch the row learns nothing
 * from holding it.
 *
 * REDIS FAN-OUT, WHEN THERE IS MORE THAN ONE REPLICA. An event produced on one
 * API instance has to reach a browser connected to another. Each instance
 * publishes to a channel and re-emits what it receives, skipping its own echo.
 * With no REDIS_URL the bus stays in-process, which is correct for a single
 * instance and is what the compose stack runs.
 */

export type EventType =
  | 'message-new'
  | 'message-status'
  | 'conversation-changed'
  | 'broadcast-progress'
  /*
   * Pharmacy.
   *
   * Identifiers only, like everything else on this pipe: a dispense record id
   * and a status, never a drug name or a patient. The counter screen and the
   * doctor's clarification card both refetch on receipt; the event says
   * "something changed", not what.
   */
  | 'rx-queued'
  | 'rx-dispensed'
  | 'rx-clarification'
  | 'heartbeat';

export interface DomainEvent {
  type: EventType;
  clinicId: string;
  /**
   * Identifiers only. Never a message body, a patient name or a phone number —
   * see the note above about what an SSE pipe is.
   */
  data: Record<string, string | number | boolean | null>;
}

type Listener = (event: DomainEvent) => void;

const CHANNEL = 'emr:events';

@Injectable()
export class EventHub implements OnApplicationShutdown {
  private readonly logger = new Logger(EventHub.name);
  private readonly bus = new EventEmitter();

  /** Distinguishes our own Redis echo from another instance's event. */
  private readonly instanceId = randomUUID();

  private publisher: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;

  constructor() {
    // One listener per connected browser tab. Node warns at ten, and a busy
    // clinic legitimately has more than that open at once.
    this.bus.setMaxListeners(500);
    void this.connectRedis();
  }

  /**
   * Publishes an event to every subscriber in this clinic, on every instance.
   *
   * Never throws. A real-time notification is an optimisation over polling, and
   * failing to deliver one must not fail the request that caused it — a doctor
   * finalising a consultation cannot be blocked because Redis is down.
   */
  emit(event: DomainEvent): void {
    try {
      this.bus.emit(CHANNEL, event);
      void this.publisher?.publish(
        CHANNEL,
        JSON.stringify({ from: this.instanceId, event }),
      );
    } catch (error) {
      this.logger.warn(`Event emit failed (ignored): ${String(error)}`);
    }
  }

  /**
   * Subscribes to one clinic's events. Returns the unsubscribe function.
   *
   * The clinic id comes from the caller's verified session, never from a query
   * parameter — which is the one thing that makes the filter below a boundary
   * rather than a suggestion.
   */
  subscribe(clinicId: string, listener: Listener): () => void {
    const scoped: Listener = (event) => {
      if (event.clinicId !== clinicId) return;
      try {
        listener(event);
      } catch (error) {
        // One broken subscriber must not take down delivery for the rest.
        this.logger.warn(`Event listener threw (ignored): ${String(error)}`);
      }
    };

    this.bus.on(CHANNEL, scoped);
    return () => this.bus.off(CHANNEL, scoped);
  }

  /** How many streams are currently open. Reported by the health endpoint. */
  get subscriberCount(): number {
    return this.bus.listenerCount(CHANNEL);
  }

  private async connectRedis(): Promise<void> {
    if (!config.REDIS_URL) {
      this.logger.log('No REDIS_URL — the event bus is in-process only.');
      return;
    }

    try {
      this.publisher = createClient({ url: config.REDIS_URL });
      this.subscriber = this.publisher.duplicate();

      // Redis being unavailable degrades real-time updates to per-instance.
      // It must not crash the API, and it must not spam the log on every retry.
      this.publisher.on('error', (error) =>
        this.logger.warn(`Redis publisher: ${error.message}`),
      );
      this.subscriber.on('error', (error) =>
        this.logger.warn(`Redis subscriber: ${error.message}`),
      );

      await this.publisher.connect();
      await this.subscriber.connect();

      await this.subscriber.subscribe(CHANNEL, (message) => {
        try {
          const parsed = JSON.parse(message) as { from: string; event: DomainEvent };
          // Our own echo was already delivered locally by emit().
          if (parsed.from === this.instanceId) return;
          this.bus.emit(CHANNEL, parsed.event);
        } catch {
          // A malformed message on a shared channel is not worth a stack trace.
        }
      });

      this.logger.log('Event bus fan-out over Redis is active.');
    } catch (error) {
      this.logger.warn(
        `Redis fan-out unavailable, continuing in-process: ${String(error)}`,
      );
      this.publisher = null;
      this.subscriber = null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
    await this.publisher?.quit().catch(() => undefined);
  }
}
