import { Injectable, Logger } from '@nestjs/common';

/**
 * The WhatsApp Business Cloud API, as this product uses it.
 *
 * A thin, honest wrapper. It does four things: verify a credential, list the
 * templates the provider has approved, send a template message, and send a
 * free-text reply inside the service window. Everything else the Cloud API
 * offers is not used, so it is not here.
 *
 * WHY THERE IS A SIMULATED MODE. A clinic without a Meta Business account still
 * has to be able to see the inbox, compose a broadcast and be told exactly who
 * it would reach — that is most of the evaluation, and most pilots start before
 * the WABA paperwork clears. When no credential is configured the client
 * SIMULATES the provider rather than pretending to succeed silently: every
 * response says `simulated: true`, the message is recorded with its real
 * lifecycle, and the interface says plainly that nothing left the building.
 *
 * The one thing simulation must never do is look like delivery. A clinic that
 * believes a prescription reminder reached a patient, when it reached nobody, is
 * worse off than a clinic that knows the channel is not connected.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface WhatsAppCredential {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
}

export interface VerifiedNumber {
  displayPhoneE164: string;
  verifiedName: string;
  qualityRating: string | null;
  messagingTier: string | null;
}

export interface ProviderTemplate {
  name: string;
  language: string;
  category: string | null;
  status: string;
  body: string;
  headerText: string | null;
  footerText: string | null;
  buttons: { type: string; text: string; url?: string }[] | null;
  variableCount: number;
}

export interface SendResult {
  providerMessageId: string;
  simulated: boolean;
}

/** What went wrong, in terms a receptionist can act on. */
export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
    /** True when retrying later could plausibly work. */
    readonly retryable = false,
  ) {
    super(message);
  }
}

@Injectable()
export class WhatsAppClient {
  private readonly logger = new Logger(WhatsAppClient.name);

  /**
   * Confirms a credential works and returns what the provider says about it.
   *
   * Called when an administrator connects a number, so that a typo in the token
   * fails HERE — in a form, next to the field, while they still have the value
   * on screen — rather than silently at 9am when the first reminder does not go
   * out.
   */
  async verify(credential: WhatsAppCredential): Promise<VerifiedNumber> {
    const data = await this.get<{
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
      throughput?: { level?: string };
    }>(
      credential,
      `${GRAPH}/${credential.phoneNumberId}` +
        '?fields=display_phone_number,verified_name,quality_rating,throughput',
    );

    if (!data.display_phone_number) {
      throw new WhatsAppError(
        'That phone number id is valid but returned no number. Check it belongs to the WhatsApp Business account you entered.',
      );
    }

    return {
      // The Graph API returns it formatted for humans; E.164 is what everything
      // else in this system stores and compares on.
      displayPhoneE164: toE164(data.display_phone_number),
      verifiedName: data.verified_name ?? 'Unverified',
      qualityRating: data.quality_rating ?? null,
      messagingTier: data.throughput?.level ?? null,
    };
  }

  /** The templates the provider has approved, rejected or paused. */
  async listTemplates(credential: WhatsAppCredential): Promise<ProviderTemplate[]> {
    const data = await this.get<{ data?: RawTemplate[] }>(
      credential,
      `${GRAPH}/${credential.wabaId}/message_templates?limit=200`,
    );

    return (data.data ?? []).map(parseTemplate);
  }

  /**
   * Sends an approved template.
   *
   * This is the ONLY way to start a conversation or to reach someone outside
   * the 24-hour service window, which is why the broadcast path uses nothing
   * else.
   */
  async sendTemplate(
    credential: WhatsAppCredential,
    args: {
      toE164: string;
      templateName: string;
      language: string;
      variables: string[];
    },
  ): Promise<SendResult> {
    if (!credential.accessToken) {
      return this.simulate('template', args.toE164, args.templateName);
    }

    const body = {
      messaging_product: 'whatsapp',
      to: args.toE164.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: args.templateName,
        language: { code: args.language },
        ...(args.variables.length > 0
          ? {
              components: [
                {
                  type: 'body',
                  parameters: args.variables.map((text) => ({ type: 'text', text })),
                },
              ],
            }
          : {}),
      },
    };

    const data = await this.post(credential, `${GRAPH}/${credential.phoneNumberId}/messages`, body);
    return { providerMessageId: firstMessageId(data), simulated: false };
  }

  /**
   * Sends free text.
   *
   * Only valid inside the 24-hour window. The provider rejects it outside, and
   * the caller is expected to have checked — but the rejection is handled
   * rather than assumed away, because the window can close between the check
   * and the send.
   */
  async sendText(
    credential: WhatsAppCredential,
    args: { toE164: string; body: string },
  ): Promise<SendResult> {
    if (!credential.accessToken) {
      return this.simulate('text', args.toE164, args.body.slice(0, 30));
    }

    const data = await this.post(credential, `${GRAPH}/${credential.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: args.toE164.replace(/^\+/, ''),
      type: 'text',
      text: { preview_url: false, body: args.body },
    });

    return { providerMessageId: firstMessageId(data), simulated: false };
  }

  /* ----------------------------------------------------------------------- */

  private simulate(kind: string, to: string, detail: string): SendResult {
    // Logged at warn, not debug. A message that did not leave the building is
    // an operational fact, and it should be visible in the logs of a
    // half-configured deployment rather than discoverable only by asking a
    // patient whether they got it.
    this.logger.warn(
      `SIMULATED ${kind} to ${to} (${detail}) — no WhatsApp credential is configured, nothing was sent.`,
    );
    return { providerMessageId: `simulated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, simulated: true };
  }

  private async get<T>(credential: WhatsAppCredential, url: string): Promise<T> {
    if (!credential.accessToken) {
      throw new WhatsAppError(
        'No WhatsApp credential is configured for this clinic.',
        'NOT_CONNECTED',
      );
    }
    return this.request<T>(url, { headers: this.authHeader(credential) });
  }

  private async post(
    credential: WhatsAppCredential,
    url: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.request(url, {
      method: 'POST',
      headers: { ...this.authHeader(credential), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private authHeader(credential: WhatsAppCredential) {
    return { authorization: `Bearer ${credential.accessToken}` };
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;

    try {
      response = await fetch(url, {
        ...init,
        // Without a timeout a provider outage becomes our outage: requests pile
        // up holding connections until the pool is exhausted, and the whole API
        // stops answering — including the screens that have nothing to do with
        // messaging.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new WhatsAppError(
        'WhatsApp could not be reached. This is usually temporary.',
        'NETWORK',
        true,
      );
    }

    const text = await response.text();
    const parsed = safeJson(text);

    if (!response.ok) {
      const detail = (parsed as { error?: { message?: string; code?: number } })?.error;
      this.logger.error(
        `WhatsApp API ${response.status} on ${new URL(url).pathname}: ${text.slice(0, 400)}`,
      );

      throw new WhatsAppError(
        friendlyError(response.status, detail?.message),
        detail?.code ? String(detail.code) : String(response.status),
        // 5xx and 429 may succeed later; a 4xx means the request itself is wrong.
        response.status >= 500 || response.status === 429,
      );
    }

    return (parsed ?? {}) as T;
  }
}

/* --------------------------------------------------------------------------- *
 * Helpers
 * --------------------------------------------------------------------------- */

interface RawTemplate {
  name: string;
  language: string;
  category?: string;
  status: string;
  components?: {
    type: string;
    format?: string;
    text?: string;
    buttons?: { type: string; text: string; url?: string }[];
  }[];
}

function parseTemplate(raw: RawTemplate): ProviderTemplate {
  const component = (type: string) =>
    raw.components?.find((c) => c.type?.toUpperCase() === type);

  const body = component('BODY')?.text ?? '';
  const header = component('HEADER');

  return {
    name: raw.name,
    language: raw.language,
    category: raw.category ?? null,
    status: raw.status?.toUpperCase() ?? 'PENDING',
    body,
    // Only a text header can be filled in by this product. An image or document
    // header needs a media id, which is a different flow entirely.
    headerText: header?.format === 'TEXT' ? (header.text ?? null) : null,
    footerText: component('FOOTER')?.text ?? null,
    buttons: component('BUTTONS')?.buttons ?? null,
    // Counted from the approved body, because the placeholders are the contract:
    // sending the wrong number of parameters is rejected by the provider.
    variableCount: countPlaceholders(body),
  };
}

/** How many distinct {{n}} placeholders a template body has. */
export function countPlaceholders(body: string): number {
  const found = new Set<number>();
  for (const match of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    found.add(Number(match[1]));
  }
  return found.size;
}

/**
 * Normalises the provider's human-formatted number to E.164.
 *
 * Meta returns things like "+91 98765 43210". Everything else in this system
 * stores E.164 and compares on it, so a number that skips this step matches
 * nothing and every conversation on it arrives unlinked.
 */
export function toE164(display: string): string {
  const digits = display.replace(/\D/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function firstMessageId(data: Record<string, unknown>): string {
  const messages = data.messages as { id?: string }[] | undefined;
  return messages?.[0]?.id ?? '';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The provider's error, said in a way someone at a clinic can act on.
 *
 * Meta's messages are written for developers — "(#131030) Recipient phone
 * number not in allowed list" tells a receptionist nothing about what to do.
 * The original is logged in full; this is what reaches the screen.
 */
function friendlyError(status: number, providerMessage?: string): string {
  if (status === 401 || status === 403) {
    return 'WhatsApp rejected the access token. It may have expired or been revoked — reconnect the number in Settings.';
  }
  if (status === 429) {
    return 'WhatsApp is rate-limiting this number. Wait a few minutes and try again.';
  }
  if (status >= 500) {
    return 'WhatsApp is having trouble at their end. This is usually temporary.';
  }
  if (providerMessage && /not in allowed list/i.test(providerMessage)) {
    return 'This number is in test mode and can only message numbers you have added to its allowed list.';
  }
  if (providerMessage && /template/i.test(providerMessage)) {
    return `WhatsApp rejected the template: ${providerMessage}`;
  }
  return providerMessage ?? 'WhatsApp rejected the request.';
}
