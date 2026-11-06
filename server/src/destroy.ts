import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from './constants';
import { stopBackgroundWork } from './bootstrap';

/** Writes anything still queued, so entries made just before a restart are not lost. */
const destroy = async ({ strapi }: { strapi: Core.Strapi }) => {
  stopBackgroundWork();

  try {
    await strapi.plugin(PLUGIN_NAME).service('writer').stop();
  } catch (error) {
    strapi.log.error(`[${PLUGIN_NAME}] Could not flush queued audit rows on shutdown.`, error);
  }
};

export default destroy;
