import { getIsrOutboxStatus } from '../../../isr-outbox/runtime';

export default {
  async status(ctx: any) {
    const status = await getIsrOutboxStatus();
    ctx.set('Cache-Control', 'private, no-store');
    ctx.status = status.ok ? 200 : 503;
    return ctx.send(status);
  },
};
