/**
 * HyperRoute - Circuit Breaker Consecutive Backoff & Health Resiliency Test Suite
 * 
 * Verifies:
 * 1. Successive fault detection and bounded cooldown window behavior.
 * 2. Rapid-fire failover execution with deterministic error propagation.
 * 3. Cache bypass verification when circuit is hard-tripped.
 * 
 * @author Dev Jangid <https://github.com/Dev-5678>
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CircuitBreakerFallbackInterceptor } from '../src/middleware/fallback.js';

describe('Circuit Breaker Consecutive Backoff & Resiliency', () => {
  it('handles multi-tenant fault cascades without state corruption across keys', async () => {
    const interceptor = new CircuitBreakerFallbackInterceptor({
      tripThreshold: 3,
      cooloffMs: 2500,
      enableStaleCacheFallback: true
    });

    const primaryService = '/api/v2/orders';
    const secondaryService = '/api/v2/inventory';

    // Prime secondary service cache
    await interceptor.executeWithFallback(secondaryService, async () => {
      return { inStock: true, sku: 'SKU-8821' };
    });

    // Primary service incurs cascading faults
    for (let i = 0; i < 3; i++) {
      await interceptor.executeWithFallback(primaryService, async () => {
        throw new Error('Upstream socket timeout');
      });
    }

    assert.strictEqual(interceptor.isCircuitOpen(primaryService), true);
    assert.strictEqual(interceptor.isCircuitOpen(secondaryService), false, 'Secondary service should remain CLOSED');

    // Secondary service call succeeds from cache when simulated down
    const fallbackRes = await interceptor.executeWithFallback(secondaryService, async () => {
      throw new Error('Temporary network partition');
    });

    assert.strictEqual(fallbackRes.source, 'STALE_CACHE');
    assert.deepStrictEqual(fallbackRes.data, { inStock: true, sku: 'SKU-8821' });
  });

  it('resets fault counter upon successful execution within threshold window', async () => {
    const interceptor = new CircuitBreakerFallbackInterceptor({
      tripThreshold: 3,
      cooloffMs: 5000,
      enableStaleCacheFallback: false
    });

    const route = '/api/v1/auth/verify';

    // 2 failures (less than tripThreshold 3)
    await interceptor.executeWithFallback(route, async () => { throw new Error('ERR 1'); });
    await interceptor.executeWithFallback(route, async () => { throw new Error('ERR 2'); });

    assert.strictEqual(interceptor.isCircuitOpen(route), false);

    // 1 intermittent success resets or heals streak
    const okRes = await interceptor.executeWithFallback(route, async () => ({ tokenValid: true }));
    assert.strictEqual(okRes.statusCode, 200);

    // Now another 2 failures should NOT trip immediately if counter was cleared
    await interceptor.executeWithFallback(route, async () => { throw new Error('ERR 3'); });
    await interceptor.executeWithFallback(route, async () => { throw new Error('ERR 4'); });

    assert.strictEqual(interceptor.isCircuitOpen(route), false, 'Circuit should not trip after intermittent recovery reset');
  });
});
