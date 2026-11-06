module.exports = ({ env }) => ({
  'cms-audit-log': {
    enabled: true,
    config: {
      // Dedicated key for the per-row signatures. Generate one with:
      //   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
      signingSecret: env('AUDIT_LOG_SIGNING_SECRET'),
    },
  },
});
