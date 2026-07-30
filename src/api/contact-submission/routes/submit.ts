export default {
  routes: [
    {
      method: 'POST',
      path: '/contact-submissions/submit',
      handler: 'submit.submit',
      config: {
        auth: false,
        middlewares: [
          {
            name: 'global::rate-limit',
            config: { maxRequests: 5, windowMs: 60_000 },
          },
        ],
      },
    },
  ],
};
