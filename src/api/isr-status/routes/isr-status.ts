export default {
  routes: [
    {
      method: 'GET',
      path: '/isr/status',
      handler: 'isr-status.status',
      config: {
        auth: false,
        policies: ['global::isr-admin-auth'],
      },
    },
  ],
};
