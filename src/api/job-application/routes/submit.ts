export default {
  routes: [
    {
      method: 'POST',
      path: '/job-applications/submit',
      handler: 'submit.submit',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::rate-limit', config: { maxRequests: 5, windowMs: 60_000 } },
        ],
      },
    },
  ],
};
