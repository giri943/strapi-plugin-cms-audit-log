import { strapiErrors } from '../utils/strapi-errors';
import { PLUGIN_NAME } from '../constants';
import { createRateLimiter } from '../core/rate-limit';
import type { PluginConfig } from '../config';
import type { PluginPolicy } from '../types';

export interface RateLimitConfig {
  bucket?: 'read' | 'export';
}

const limiter = createRateLimiter(60_000);

/**
 * Per-user request budget for the plugin's endpoints. Keyed on the admin user id, so one
 * account cannot drain the database with exports or scripted paging (OWASP API4).
 */
const rateLimit: PluginPolicy<RateLimitConfig> = (ctx, config, { strapi }) => {
  const bucket = config?.bucket ?? 'read';
  const settings = (strapi.config.get(`plugin::${PLUGIN_NAME}`) ?? {}) as Partial<PluginConfig>;
  const limit = bucket === 'export' ? (settings.exportsPerMinute ?? 5) : (settings.readsPerMinute ?? 240);

  const user = ctx.state?.user as { id?: unknown } | undefined;
  const key = `${bucket}:${user?.id ?? ctx.request?.ip ?? 'unknown'}`;
  const decision = limiter.take(key, limit);

  if (!decision.allowed) {
    (ctx as unknown as { set(name: string, value: string): void }).set(
      'Retry-After',
      String(decision.retryAfterSeconds)
    );
    throw new (strapiErrors(strapi).RateLimitError)(
      `Too many requests. Try again in ${decision.retryAfterSeconds} second(s).`,
      { retryAfter: decision.retryAfterSeconds }
    );
  }

  return true;
};

export const resetRateLimits = () => limiter.reset();

export default rateLimit;
