export default {
  routes: [{
    method: 'GET',
    path: '/global/newsletter-config',
    handler: 'global.newsletterConfig',
    config: { auth: false, policies: ['global::isr-admin-auth'] },
  }],
};
