import { describe, expect, it } from 'vitest';
import { firstLineTitle, parseTelegramPost, safeHttpUrl } from './parse-post';

describe('parseTelegramPost', () => {
  it('reads the first non-empty line as the title, without leading emoji or bullets', () => {
    expect(firstLineTitle('🔥 Myntra Loot 🔥\nBranded shoes @ ₹499')).toBe('Myntra Loot 🔥');
    expect(firstLineTitle('\n\n  • Flash Deal  \nrest')).toBe('Flash Deal');
    expect(firstLineTitle('   ')).toBeNull();
  });

  it('caps a very long title', () => {
    const title = firstLineTitle('x'.repeat(400));
    expect(title).toHaveLength(160);
    expect(title?.endsWith('…')).toBe(true);
  });

  it('uses a strikethrough amount as the MRP and the plain one as the price', () => {
    const text = 'boAt Earbuds worth ₹2,999 listed at ₹149!';
    const struckStart = text.indexOf('₹2,999');
    const parsed = parseTelegramPost(text, [
      { type: 'strikethrough', offset: struckStart, length: '₹2,999'.length },
    ]);
    expect(parsed).toMatchObject({ salePrice: 149, mrp: 2999, discountLabel: '95% OFF' });
  });

  it('treats "worth X at Y" as list price then sale price when nothing is struck', () => {
    const parsed = parseTelegramPost('Nike shoes worth ₹7,999 at ₹1,299 — limited stock!', []);
    expect(parsed.salePrice).toBe(1299);
    expect(parsed.mrp).toBe(7999);
    expect(parsed.discountLabel).toBe('84% OFF');
  });

  it('prefers an explicit percent-off label over the computed one', () => {
    const parsed = parseTelegramPost('Dyson Big Ball\nRs. 25,898 (was Rs. 43,900) Flat 41% off', []);
    expect(parsed.discountLabel).toBe('Flat 41% OFF');
    expect(parsed.salePrice).toBe(25898);
    expect(parsed.mrp).toBe(43900);
  });

  it('keeps a single amount as the price with no MRP or discount', () => {
    const parsed = parseTelegramPost('Branded shoes @ ₹499 only! Use code LOOT499', []);
    expect(parsed).toMatchObject({ salePrice: 499, mrp: null, discountLabel: null });
  });

  it('does not advertise cashback or a second product price as a markdown', () => {
    expect(parseTelegramPost('Headphones ₹2999 plus ₹500 cashback', [])).toMatchObject({ salePrice: 2999, mrp: null, discountLabel: null });
    expect(parseTelegramPost('Cashback of ₹500. Headphones ₹2999', [])).toMatchObject({ salePrice: 2999, mrp: null });
    expect(parseTelegramPost('Headphones ₹2999, speakers ₹1999', [])).toMatchObject({ salePrice: 2999, mrp: null });
  });

  it('drops an MRP that is not above the sale price', () => {
    const text = 'Deal ₹500 ₹400';
    const parsed = parseTelegramPost(text, [
      { type: 'strikethrough', offset: text.indexOf('₹400'), length: 4 },
    ]);
    expect(parsed.salePrice).toBe(500);
    expect(parsed.mrp).toBeNull();
  });

  it('takes the first safe link from text_link, url entities, then bare text', () => {
    const text = 'Buy here and enjoy';
    const viaTextLink = parseTelegramPost(text, [
      { type: 'text_link', offset: 0, length: 8, url: 'https://www.amazon.in/dp/B00?tag=cg' },
    ]);
    expect(viaTextLink.ctaUrl).toBe('https://www.amazon.in/dp/B00?tag=cg');
    expect(viaTextLink.storeDomain).toBe('amazon.in');

    const bare = 'Grab it: https://flipkart.com/x/y, hurry';
    expect(parseTelegramPost(bare, []).ctaUrl).toBe('https://flipkart.com/x/y');
    expect(parseTelegramPost(bare, []).storeDomain).toBe('flipkart.com');
  });

  it('rejects unsafe or credentialed links', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('https://user:pw@evil.example/')).toBeNull();
    expect(safeHttpUrl('//evil.example/')).toBeNull();
    const parsed = parseTelegramPost('x', [
      { type: 'text_link', offset: 0, length: 1, url: 'ftp://evil.example/' },
    ]);
    expect(parsed.ctaUrl).toBeNull();
    expect(parsed.storeDomain).toBeNull();
  });

  it('handles other currency tokens', () => {
    expect(parseTelegramPost('AED 129 only', []).salePrice).toBe(129);
    expect(parseTelegramPost('S$ 45.50 today', []).salePrice).toBe(45.5);
    expect(parseTelegramPost('$1,299', []).salePrice).toBe(1299);
  });

  it('tolerates missing text and entities', () => {
    expect(parseTelegramPost(null, null)).toEqual({
      title: null,
      salePrice: null,
      mrp: null,
      discountLabel: null,
      ctaUrl: null,
      storeDomain: null,
    });
  });
});

it('parses ungrouped four-digit and larger prices without truncation', () => {
  expect(parseTelegramPost('Only ₹2999.50', []).salePrice).toBe(2999.5);
  expect(parseTelegramPost('Only Rs. 125000', []).salePrice).toBe(125000);
});


describe('numeric title preservation', () => {
  it.each(['50% off on Nike', '128GB phone', '2026 offers', '#1 bestseller', '*special offer'])('preserves %s', title => {
    expect(parseTelegramPost(title, []).title).toBe(title);
  });
  it.each(['🔥 50% off', '👩🏽‍💻 50% off', '🇮🇳 50% off', '1️⃣ 50% off', '### 50% off', '**50% off**'])('removes complete decoration in %s', title => {
    expect(parseTelegramPost(title, []).title).toBe('50% off');
  });
});
