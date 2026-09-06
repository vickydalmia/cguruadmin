// Raw migration writes bypass Strapi's document service, so they must set the
// i18n source locale themselves. This is deliberately `en`, not the regional
// presentation locale (`en-AE`, `en-US`, ...).
export const DEFAULT_CONTENT_LOCALE = "en";
