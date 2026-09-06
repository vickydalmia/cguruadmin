import { describe, expect, it, vi } from 'vitest';

import {
  CSV_BOM,
  assembleCsv,
  exportErrorMessage,
  exportFileName,
  exportPagePath,
  isAbortError,
  progressPercent,
  runCsvExport,
  unwrapPage,
} from './api';

describe('exportPagePath', () => {
  it('targets the admin-router prefix with the uid encoded', () => {
    expect(exportPagePath('api::coupon.coupon', 3, 250)).toBe(
      '/csv-export/api%3A%3Acoupon.coupon?page=3&pageSize=250',
    );
  });
});

describe('unwrapPage', () => {
  const page = { uid: 'api::bank.bank', page: 1, pageSize: 100, total: 3, pageCount: 1, header: 'id\r\n', lines: '1\r\n', rowCount: 1 };

  it('accepts the bare body and both envelope shapes', () => {
    expect(unwrapPage({ data: page })).toMatchObject({ total: 3, rowCount: 1 });
    expect(unwrapPage({ data: { data: page } })).toMatchObject({ total: 3 });
    expect(unwrapPage(page)).toMatchObject({ total: 3 });
  });

  it('rejects anything that is not a page, so an HTML error never counts as rows', () => {
    expect(() => unwrapPage({ data: '<html>' })).toThrow(/unexpected response/);
    expect(() => unwrapPage({ data: { total: 1 } })).toThrow(/unexpected response/);
  });

  it('never returns a page count below one', () => {
    expect(unwrapPage({ data: { ...page, pageCount: 0 } }).pageCount).toBe(1);
  });
});

describe('file name and progress', () => {
  it('names the file by target stem and local date', () => {
    expect(exportFileName('api::coupon.coupon', new Date(2026, 7, 23))).toBe('coupons-2026-08-23.csv');
    expect(exportFileName('api::category.category', new Date(2026, 0, 5))).toBe('categories-2026-01-05.csv');
  });

  it('reports whole percentages bounded to 0..100', () => {
    expect(progressPercent(0, 0)).toBe(0);
    expect(progressPercent(250, 25374)).toBe(0);
    expect(progressPercent(4250, 25374)).toBe(16);
    expect(progressPercent(25374, 25374)).toBe(100);
    expect(progressPercent(30000, 25374)).toBe(100);
  });

  it('assembles BOM, header once, then every chunk in order', () => {
    expect(assembleCsv('h\r\n', ['1\r\n', '2\r\n'])).toBe(`${CSV_BOM}h\r\n1\r\n2\r\n`);
    expect(CSV_BOM).toBe('\ufeff');
    expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff);
  });
});

describe('error wording', () => {
  it('tells a non-super-admin why, and otherwise surfaces the server message', () => {
    expect(exportErrorMessage({ status: 403 }, 'api::store.store')).toBe(
      'Only a Super Admin can export Stores.',
    );
    expect(exportErrorMessage({ response: { status: 401 } }, 'api::deal.deal')).toMatch(/Super Admin/);
    expect(
      exportErrorMessage(
        { response: { data: { error: { message: 'pageSize must be…' } } } },
        'api::bank.bank',
      ),
    ).toBe('pageSize must be…');
    expect(exportErrorMessage({}, 'api::bank.bank')).toBe('The export failed. Please try again.');
  });

  it('recognises the fetch client abort shapes', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
    expect(isAbortError({ code: 'ERR_CANCELED' })).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
  });
});

describe('runCsvExport', () => {
  function pagedClient(total: number, pageSize: number) {
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const get = vi.fn(async (url: string) => {
      const page = Number(new URL(url, 'http://x').searchParams.get('page'));
      const start = (page - 1) * pageSize;
      const rows = Math.max(0, Math.min(pageSize, total - start));
      return {
        data: {
          uid: 'api::coupon.coupon',
          page,
          pageSize,
          total,
          pageCount,
          header: 'id\r\n',
          lines: Array.from({ length: rows }, (_, i) => `${start + i + 1}\r\n`).join(''),
          rowCount: rows,
        },
      };
    });
    return { get };
  }

  it('walks every page sequentially, reports exact progress and assembles the file', async () => {
    const client = pagedClient(5, 2);
    const progress: any[] = [];
    const result = await runCsvExport(client, 'api::coupon.coupon', {
      pageSize: 2,
      onProgress: (p) => progress.push(p),
      now: () => new Date(2026, 7, 23),
    });

    expect(client.get).toHaveBeenCalledTimes(3);
    expect(client.get.mock.calls.map(([url]) => url)).toEqual([
      '/csv-export/api%3A%3Acoupon.coupon?page=1&pageSize=2',
      '/csv-export/api%3A%3Acoupon.coupon?page=2&pageSize=2',
      '/csv-export/api%3A%3Acoupon.coupon?page=3&pageSize=2',
    ]);
    expect(progress.map((p) => [p.done, p.total, p.percent, p.page, p.pageCount])).toEqual([
      [2, 5, 40, 1, 3],
      [4, 5, 80, 2, 3],
      [5, 5, 100, 3, 3],
    ]);
    expect(result).toEqual({
      fileName: 'coupons-2026-08-23.csv',
      rows: 5,
      text: `${CSV_BOM}id\r\n1\r\n2\r\n3\r\n4\r\n5\r\n`,
    });
  });

  it('handles an empty collection with a single request', async () => {
    const client = pagedClient(0, 100);
    const result = await runCsvExport(client, 'api::bank.bank', { pageSize: 100 });
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(result.rows).toBe(0);
    expect(result.text).toBe(`${CSV_BOM}id\r\n`);
  });

  it('stops early when a page comes back empty because the collection shrank', async () => {
    const get = vi.fn(async (url: string) => {
      const page = Number(new URL(url, 'http://x').searchParams.get('page'));
      return {
        data: {
          total: 300,
          pageCount: 3,
          header: 'id\r\n',
          lines: page === 1 ? '1\r\n' : '',
          rowCount: page === 1 ? 1 : 0,
        },
      };
    });
    const result = await runCsvExport({ get } as any, 'api::coupon.coupon', { pageSize: 100 });
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.rows).toBe(1);
  });

  it('passes the abort signal through and stops once it is aborted', async () => {
    const controller = new AbortController();
    const get = vi.fn(async (_url: string, config: any) => {
      expect(config.signal).toBe(controller.signal);
      controller.abort();
      return {
        data: { total: 500, pageCount: 5, header: 'id\r\n', lines: '1\r\n', rowCount: 1 },
      };
    });
    await expect(
      runCsvExport({ get } as any, 'api::coupon.coupon', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
