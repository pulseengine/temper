import { JobQueue } from '../../src/queue.js';

describe('JobQueue', () => {
  it('processes jobs sequentially', async () => {
    const queue = new JobQueue();
    const order = [];
    queue.enqueue(async () => { order.push(1); }, 'job-1');
    queue.enqueue(async () => { order.push(2); }, 'job-2');
    queue.enqueue(async () => { order.push(3); }, 'job-3');

    // Wait for processing
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([1, 2, 3]);
  });

  it('tracks stats correctly', async () => {
    const queue = new JobQueue();
    expect(queue.stats()).toEqual({ pending: 0, active: 0, completed: 0, failed: 0 });

    queue.enqueue(async () => {}, 'ok');
    queue.enqueue(async () => { throw new Error('fail'); }, 'bad');

    await new Promise((r) => setTimeout(r, 50));
    expect(queue.stats().completed).toBe(1);
    expect(queue.stats().failed).toBe(1);
  });

  it('continues after a failing job', async () => {
    const queue = new JobQueue();
    const results = [];
    queue.enqueue(async () => { throw new Error('boom'); }, 'fail');
    queue.enqueue(async () => { results.push('ok'); }, 'success');

    await new Promise((r) => setTimeout(r, 50));
    expect(results).toEqual(['ok']);
    expect(queue.stats().failed).toBe(1);
    expect(queue.stats().completed).toBe(1);
  });
});
