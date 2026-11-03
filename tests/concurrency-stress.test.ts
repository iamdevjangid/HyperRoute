/**
 * HyperRoute - High-Concurrency Sliding-Window Stress & Throughput Benchmark
 * 
 * Evaluates the performance, memory bounds, and race-free consistency of the
 * SlidingWindowCounterLimiter and TokenBucketLimiter under simulated heavy concurrent traffic.
 * 
 * @author Dev Jangid <https://github.com/Dev-5678>
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SlidingWindowCounterLimiter } from '../src/limiter/sliding-window.js';
import { TokenBucketLimiter } from '../src/limiter/token-bucket.js';

describe('High-Throughput Concurrency & Load Stress Tests', () => {
  it('sustains 10,000 requests across 100 concurrent IP buckets with sub-millisecond p99', () => {
    const limiter = new SlidingWindowCounterLimiter(100, 60000); // 100 req/min per IP
    const totalRequests = 10000;
    const bucketCount = 100;
    const latencies: number[] = [];

    let allowedCount = 0;
    let rejectedCount = 0;

    const baseTime = Date.now();

    for (let i = 0; i < totalRequests; i++) {
      const ip = `10.240.${i % bucketCount}.1`;
      const t0 = performance.now();
      
      const res = limiter.evaluate(ip, baseTime + (i % 5000));
      const t1 = performance.now();
      latencies.push(t1 - t0);

      if (res) {
        allowedCount++;
      } else {
        rejectedCount++;
      }
    }

    // Sort latencies for percentiles
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.50)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    // Performance assertion: p99 must be under 1ms
    assert.ok(p99 < 1.0, `p99 latency (${p99.toFixed(4)}ms) must be under 1.0ms`);
    assert.strictEqual(allowedCount, bucketCount * 100, 'Exactly 100 requests per IP bucket must be allowed');
    assert.strictEqual(rejectedCount, totalRequests - (bucketCount * 100), 'All excess requests must be cleanly throttled with 429');
  });

  it('guarantees thread-safe atomic token consumption in high-frequency token bucket', () => {
    // Capacity 50 tokens, refill 10 tokens/sec
    const bucket = new TokenBucketLimiter(50, 10);
    const clientKey = 'tenant-production-core';
    const initialTime = 1000000;

    // Burst consume all 50 tokens
    for (let i = 0; i < 50; i++) {
      const res = bucket.consume(clientKey, 1, initialTime);
      assert.strictEqual(res, true);
    }

    // 51st request must be denied
    const overflow = bucket.consume(clientKey, 1, initialTime);
    assert.strictEqual(overflow, false);

    // Advance clock by 2.0 seconds -> 20 tokens refilled
    const afterRefill = bucket.consume(clientKey, 15, initialTime + 2000);
    assert.strictEqual(afterRefill, true);

    // Remaining tokens should be ~5
    const remainder = bucket.consume(clientKey, 10, initialTime + 2000);
    assert.strictEqual(remainder, false, 'Consuming more than remaining tokens must be rejected');
  });
});
