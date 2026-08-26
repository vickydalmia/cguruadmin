import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanHtml, sanitizeRichtextData, RICHTEXT_FIELDS } from './sanitize-richtext';
// The migration workspace holds the original allowlist this module copies —
// both feed HTML rendered raw on the public site, so they must never drift.
import { cleanHtml as migrationCleanHtml } from '../../migration/src/utils/sanitize';

describe('cleanHtml', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps allowlisted formatting markup', () => {
    const html =
      '<h2>Title</h2><p><strong>bold</strong> and <em>italic</em></p>' +
      '<ul><li>one</li></ul>' +
      '<table><tbody><tr><td>cell</td></tr></tbody></table>';
    expect(cleanHtml(html)).toBe(html);
  });

  it('strips script tags and event handlers', () => {
    expect(cleanHtml('<p onclick="alert(1)">hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });

  it('drops javascript: and data: URLs', () => {
    const out = cleanHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript:');
    const img = cleanHtml('<img src="data:text/html;base64,xxx" />');
    expect(img ?? '').not.toContain('data:');
  });

  it('forces rel="noopener noreferrer" on links, adding nofollow when external', () => {
    // First-party classification comes from the deployment's own URL; there is
    // no built-in domain, so the test states which deployment it is.
    vi.stubEnv('STRAPI_ADMIN_PUBLIC_SITE_URL', 'https://www.example.com');
    expect(cleanHtml('<a href="https://a.b" target="_blank">x</a>')).toContain(
      'rel="nofollow noopener noreferrer"'
    );
    // Internal absolute URLs (any host on the deployment's domain) and
    // relative paths stay followed — the editor cannot set rel, so the
    // sanitizer's policy must never nofollow the site's own pages.
    expect(cleanHtml('<a href="https://www.example.com/nike-coupons/">x</a>')).toContain(
      'rel="noopener noreferrer"'
    );
    expect(cleanHtml('<a href="/nike-coupons/">x</a>')).toContain(
      'rel="noopener noreferrer"'
    );
    expect(cleanHtml('<a href="/nike-coupons/">x</a>')).not.toContain('nofollow');
    // A lookalike host does not count as internal.
    expect(cleanHtml('<a href="https://example.com.evil.example/">x</a>')).toContain(
      'rel="nofollow noopener noreferrer"'
    );
  });

  it('treats every absolute link as external when no deployment URL is set', () => {
    // Fail-safe direction: without configuration nothing is first-party, so a
    // misconfigured stack over-nofollows instead of granting link equity to
    // some other deployment's domain. Relative paths are unaffected.
    expect(cleanHtml('<a href="https://www.example.com/x/">x</a>')).toContain(
      'rel="nofollow noopener noreferrer"'
    );
    expect(cleanHtml('<a href="/x/">x</a>')).not.toContain('nofollow');
  });

  it('is idempotent on its own output', () => {
    const first = cleanHtml(
      '<p>text <a href="https://a.b" target="_blank">link</a> <sup>1</sup></p><div>d</div>'
    );
    expect(cleanHtml(first)).toBe(first);
  });

  it('derives first-party hosts from the deployment domain', () => {
    vi.stubEnv('STRAPI_ADMIN_PUBLIC_SITE_URL', 'https://www.couponzguru.us');
    // The registrable domain of the configured URL is internal — apex and
    // every subdomain — so re-saving content never rewrites existing
    // first-party links to nofollow.
    expect(cleanHtml('<a href="https://www.couponzguru.us/stores/">x</a>')).not.toContain(
      'nofollow',
    );
    expect(cleanHtml('<a href="https://cms.couponzguru.us/stores/">x</a>')).not.toContain(
      'nofollow',
    );
    expect(cleanHtml('<a href="https://couponzguru.us/stores/">x</a>')).not.toContain(
      'nofollow',
    );
    // Another country's domain is external to this deployment.
    expect(cleanHtml('<a href="https://www.couponzguru.com/stores/">x</a>')).toContain(
      'nofollow',
    );
  });

  it('does not confuse sibling hosts on a multi-label public suffix', () => {
    vi.stubEnv('STRAPI_ADMIN_PUBLIC_SITE_URL', 'https://www.couponzguru.co.ke');
    expect(cleanHtml('<a href="https://cms.couponzguru.co.ke/banner/">x</a>')).not.toContain(
      'nofollow',
    );
    expect(cleanHtml('<a href="https://attacker.co.ke/banner/">x</a>')).toContain(
      'nofollow',
    );
  });

  it('returns null for empty or fully-stripped input', () => {
    expect(cleanHtml(null)).toBeNull();
    expect(cleanHtml('   ')).toBeNull();
    expect(cleanHtml('<script>x()</script>')).toBeNull();
  });
});

describe('sanitizeRichtextData', () => {
  it('sanitizes only configured fields, in place', () => {
    const data = {
      content: '<p onclick="x()">ok</p>',
      title: '<script>keep-me-untouched</script>',
    };
    sanitizeRichtextData('api::coupon.coupon', data);
    expect(data.content).toBe('<p>ok</p>');
    expect(data.title).toBe('<script>keep-me-untouched</script>');
  });

  it('ignores unknown uids and non-string values', () => {
    const data = { description: 123 as any };
    sanitizeRichtextData('api::store.store', data);
    expect(data.description).toBe(123);
    expect(() => sanitizeRichtextData('api::other.other', { x: 1 })).not.toThrow();
    expect(() => sanitizeRichtextData('api::store.store', null)).not.toThrow();
  });

  it('sanitizes rich text nested in legal page sections', () => {
    const data = {
      sections: [
        { title: 'Safe', body: '<p onclick="x()">copy</p><script>x()</script>' },
        { title: 'Not supplied' },
      ],
    };

    sanitizeRichtextData('api::privacy-policy-page.privacy-policy-page', data);

    expect(data.sections[0]?.body).toBe('<p>copy</p>');
    expect(data.sections[1]).toEqual({ title: 'Not supplied' });
  });

  it('covers both legal page single types', () => {
    const privacy = { sections: [{ body: '<p onmouseover="x()">privacy</p>' }] };
    const terms = { sections: [{ body: '<p onmouseover="x()">terms</p>' }] };

    sanitizeRichtextData('api::privacy-policy-page.privacy-policy-page', privacy);
    sanitizeRichtextData('api::terms-and-conditions-page.terms-and-conditions-page', terms);

    expect(privacy.sections[0]?.body).toBe('<p>privacy</p>');
    expect(terms.sections[0]?.body).toBe('<p>terms</p>');
  });

  it('covers all six richtext fields', () => {
    expect(Object.keys(RICHTEXT_FIELDS).sort()).toEqual([
      'api::bank.bank',
      'api::brand.brand',
      'api::category.category',
      'api::coupon.coupon',
      'api::deal.deal',
      'api::store.store',
    ]);
  });
});

describe('allowlist parity with migration/src/utils/sanitize.ts', () => {
  // One probe per allowlist dimension: if either copy of the config is
  // hardened or loosened without the other, at least one probe diverges.
  const PROBES = [
    // structural + formatting tags
    '<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><h5>e</h5><h6>f</h6>',
    '<p>p</p><br /><hr /><blockquote>q</blockquote><pre>x</pre><code>y</code>',
    '<strong>s</strong><b>b</b><em>e</em><i>i</i><u>u</u><s>st</s>',
    '<sub>1</sub><sup>2</sup><mark>m</mark><small>sm</small><span>sp</span><div>d</div>',
    '<ul><li>u</li></ul><ol><li>o</li></ol><dl><dt>t</dt><dd>d</dd></dl>',
    '<figure><img src="https://a.b/i.png" /><figcaption>c</figcaption></figure>',
    '<table><caption>t</caption><colgroup><col /></colgroup><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td rowspan="2">c</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>',
    // attributes
    '<a href="https://a.b" title="t" target="_blank" rel="nofollow">l</a>',
    '<img src="https://a.b/i.png" srcset="https://a.b/i2.png 2x" sizes="100vw" alt="a" title="t" width="10" height="10" loading="lazy" />',
    '<p class="c" id="i">attrs</p>',
    // things that must be stripped
    '<script>alert(1)</script><style>.x{}</style><iframe src="https://a.b"></iframe>',
    '<p onclick="x()" style="color:red">handlers</p>',
    '<a href="javascript:alert(1)">js</a><a href="//protocol.relative">pr</a>',
    '<img src="data:image/png;base64,x" /><a href="mailto:a@b.c">m</a><a href="tel:+123">t</a>',
    // empties
    '', '   ', '<script>only</script>',
  ];

  it('sanitizes identically to the migration allowlist', () => {
    for (const probe of PROBES) {
      expect(cleanHtml(probe), `probe: ${probe.slice(0, 60)}`).toBe(
        migrationCleanHtml(probe)
      );
    }
  });
});
