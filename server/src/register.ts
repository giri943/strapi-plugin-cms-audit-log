import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from './constants';
import { permissionActionDefinitions } from './permissions';
import type { DocumentContext } from './services/capture';

const register = ({ strapi }: { strapi: Core.Strapi }) => {
  try {
    strapi.service('admin::permission').actionProvider.registerMany(permissionActionDefinitions);
  } catch (error) {
    strapi.log.error(
      `[${PLUGIN_NAME}] Failed to register admin permission actions. Nobody can be granted access to the audit log until this is fixed.`,
      error
    );
  }

  /**
   * Content writes are captured here, in `register`, so the middleware wraps every document
   * write from the first request on, whichever plugin or controller issues it.
   */
  strapi.documents.use(async (context, next) =>
    strapi
      .plugin(PLUGIN_NAME)
      .service('capture')
      .handleDocument(context as unknown as DocumentContext, next as () => Promise<unknown>)
  );

  strapi.server.use(strapi.plugin(PLUGIN_NAME).service('capture').loginFailureMiddleware());
};

export default register;
