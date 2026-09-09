/** Shared destinations; translated CTA copy remains on the requested Global row. */
export function publicGlobalIntegrations(global: any, source: any) {
  if (!global && !source) return null;
  const result = { ...global, telegramUrl: source?.telegramUrl ?? '', whatsappUrl: source?.whatsappUrl ?? '' };
  delete result.sendyUrl;
  delete result.sendyListId;
  // Compatibility for the previous storefront during an admin-first rollout.
  // There is no second editable URL: this is derived from the shared field.
  if (result.telegramCta || result.telegramUrl) {
    result.telegramCta = { ...result.telegramCta, ctaUrl: result.telegramUrl };
  }
  return result;
}

export function publicChannelFooter(footer: any, global: any) {
  if (!footer) return footer;
  const socialLinks = (footer.socialLinks ?? []).filter(
    (link: any) => link.platform !== 'telegram' && link.platform !== 'whatsapp',
  );
  for (const platform of ['telegram', 'whatsapp']) {
    const url = global?.[`${platform}Url`];
    if (url) socialLinks.push({ platform, url });
  }
  return { ...footer, socialLinks };
}
