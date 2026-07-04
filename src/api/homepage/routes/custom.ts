export default {
  routes: [
    {
      method: 'GET',
      path: '/homepage-full',
      handler: 'custom.homepageFull',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/site-chrome',
      handler: 'custom.siteChrome',
      config: { auth: false },
    },
  ],
};
