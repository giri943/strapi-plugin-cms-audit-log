import { createRequire } from 'node:module';
import path from 'node:path';
import type { Core } from '@strapi/strapi';
import { errors as bundledErrors } from '@strapi/utils';

type ErrorClasses = typeof bundledErrors;

let cached: ErrorClasses | null = null;

/**
 * The `@strapi/utils` error classes that Strapi itself checks against.
 *
 * Strapi's error middleware turns a thrown error into a 400/403/429 with
 * `instanceof errors.ApplicationError`. If the project's `node_modules` holds two copies of
 * `@strapi/utils` (another package pulled in a newer one), the copy this plugin resolves by
 * default may not be the one `@strapi/core` uses, and every validation error becomes a 500.
 * Loading the classes from `@strapi/core`'s own location avoids that.
 */
export function strapiErrors(strapi: Core.Strapi): ErrorClasses {
  if (cached) return cached;

  try {
    const root = (strapi.dirs as { app?: { root?: string } } | undefined)?.app?.root ?? process.cwd();
    const fromApp = createRequire(path.join(root, 'package.json'));
    const coreEntry = fromApp.resolve('@strapi/core');
    const utils = createRequire(coreEntry)('@strapi/utils') as { errors?: ErrorClasses };

    cached = utils.errors ?? bundledErrors;
  } catch {
    cached = bundledErrors;
  }

  return cached;
}

/** For tests. */
export function resetStrapiErrors() {
  cached = null;
}
