module.exports = ({ env }) => ({
  auth: {
    secret: env('ADMIN_JWT_SECRET', 'playground-admin-jwt-secret'),
  },
  apiToken: {
    salt: env('API_TOKEN_SALT', 'playground-api-token-salt'),
  },
  transfer: {
    token: {
      salt: env('TRANSFER_TOKEN_SALT', 'playground-transfer-token-salt'),
    },
  },
  /**
   * Strapi caps admin logins at five attempts per five minutes per email and IP. That is the
   * right default for a real site and a nuisance for a scripted check that logs in repeatedly,
   * so the playground can switch it off with `AUDIT_DISABLE_RATE_LIMIT=true`.
   *
   * Never do this in a deployed application.
   */
  rateLimit: {
    enabled: env.bool('AUDIT_DISABLE_RATE_LIMIT', false) === false,
  },
});
