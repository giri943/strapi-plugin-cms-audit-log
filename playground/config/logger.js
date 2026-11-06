module.exports = ({ env }) => ({
  level: env('STRAPI_LOG_LEVEL', 'info'),
});
