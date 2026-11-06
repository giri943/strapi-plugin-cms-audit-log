import type { Context } from 'koa';
import type { Core } from '@strapi/strapi';

/**
 * Route handler context.
 *
 * `params` comes from the router rather than from Koa itself, so Strapi's own `Context` does not
 * declare it.
 */
export type RequestContext = Context & {
  params: Record<string, string | undefined>;
};

/**
 * Policy context.
 *
 * At runtime Strapi builds this with `Object.assign({ is, type }, ctx)`, so it is the whole Koa
 * context. The shipped `Core.PolicyContext` type only covers `ExtendableContext`, which leaves
 * out `state` and the router's `params`.
 */
export type PolicyContext = Core.PolicyContext &
  Pick<Context, 'state' | 'request'> & {
    params: Record<string, string | undefined>;
  };

/**
 * Policy handler.
 *
 * Strapi awaits the result (`services/server/policy.js`) and treats anything other than `true`
 * or `undefined` as a denial, but `Core.PolicyHandler` declares a synchronous return.
 */
export type PluginPolicy<TConfig = unknown> = (
  ctx: PolicyContext,
  config: TConfig,
  deps: { strapi: Core.Strapi }
) => Promise<boolean | undefined> | boolean | undefined;
