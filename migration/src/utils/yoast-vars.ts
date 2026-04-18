/**
 * Resolves Yoast SEO template variables like %%title%%, %%sep%%, %%sitename%%
 */
export function resolveYoastVariables(
  template: string | null | undefined,
  entityTitle: string
): string {
  if (!template) return "";

  return template
    .replace(/%%title%%/g, entityTitle)
    .replace(/%%sep%%/g, "-")
    .replace(/%%sitename%%/g, "CouponzGuru")
    .replace(/%%page%%/g, "")
    .replace(/%%primary_category%%/g, "")
    .replace(/%%category%%/g, "")
    .replace(/%%tag%%/g, "")
    .replace(/%%term_title%%/g, entityTitle)
    .replace(/%%term_description%%/g, "")
    .replace(/%%excerpt%%/g, "")
    .replace(/%%date%%/g, "")
    .replace(/%%year%%/g, new Date().getFullYear().toString())
    .replace(/%%currentyear%%/g, new Date().getFullYear().toString())
    .replace(/%%cf_\w+%%/g, "")
    .replace(/%%\w+%%/g, "") // catch-all for remaining variables
    .replace(/\s{2,}/g, " ")
    .trim();
}
