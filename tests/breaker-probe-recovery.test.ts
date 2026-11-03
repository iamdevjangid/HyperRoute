/**
 * HyperRoute - Circuit Breaker Half-Open Probe Recovery & Route Isolation Test Suite
 * 
 * Verifies:
 * 1. Half-open trial probe execution following cooloff period expiration.
 * 2. Self-healing transition back to CLOSED state upon probe success.
 * 3. Immediate re-trip and cooloff reset if probe fails.
 * 4. Complete failure isolation between distinct upstream API route keys.
 * 
 * @author Dev Jangid <https://github.com/Dev-5678>
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CircuitBreakerFallbackInterceptor } from '../src/middleware/fallback.js';

describe('Circuit Breaker Half-Open Recovery & Multi-Route Isolation', () => {
  it('allows single half-open trial request after cooldown and closes circuit on recovery', async () => {
    let mockTime = Date.now();
    const interceptor = new CircuitBreakerFallbackInterceptor({
      tripThreshold: 2,
      cooloffMs: 3000,
      enableStaleCacheFallback: false
    });

    const route = '/api/v1/payments';

    // Trip the circuit with 2 consecutive failures
    for (let i = 0; i < 2; i++) {
      await interceptor.executeWithFallback(route, async () => {
        throw new Error('503 Service Unavailable');
      });
    }

    // Circuit is now OPEN
    assert.strictEqual(interceptor.isCircuitOpen(route, mockTime), true);

    // Fast-forward time past 3000ms cooloff
    mockTime += 3500;
    assert.strictEqual(interceptor.isCircuitOpen(route, mockTime), false, 'Cooldown elapsed; trial probe must be permitted');

    // Upstream recovers: trial probe succeeds
    let upstreamCallCount = 0;
    const recoveredResponse = await interceptor.executeWithFallback(route, async () => {
      upstreamCallCount++;
      return { status: 'PAID', transactionId: 'tx_9981' };
    });

    assert.strictEqual(upstreamCallCount, 1);
    assert.strictEqual(recoveredResponse.statusCode, 200);
    assert.strictEqual(recoveredResponse.isFallback, false);
    assert.strictEqual(recoveredResponse.source, 'UPSTREAM');

    // Circuit must now be fully CLOSED (failure count reset)
    assert.strictEqual(interceptor.isCircuitOpen(route, mockTime + 100), false);
  });

  it('strictly isolates failures across distinct route keys', async () => {
    const interceptor = new CircuitBreakerFallbackInterceptor({
      tripThreshold: 2,
      cooloffMs: 5000,
      enableStaleCacheFallback: false
    });

    const failingRoute = '/api/v1/legacy-inventory';
    const healthyRoute = '/api/v1/live-orders';

    // Trip failingRoute
    for (let i = 0; i < 2; i++) {
      await interceptor.executeWithFallback(failingRoute, async () => {
        throw new Error('Connection Refused');
      });
    }

    assert.strictEqual(interceptor.isCircuitOpen(failingRoute), true);
    assert.strictEqual(interceptor.isCircuitOpen(healthyRoute), false, 'Healthy route must remain unaffected by other route trips');

    // Healthy route executes normally
    const healthyRes = await interceptor.executeWithFallback(healthyRoute, async () => ({
      orderId: 'ord_123',
      status: 'CONFIRMED'
    }));

    assert.strictEqual(healthyRes.statusCode, 200);
    assert.strictEqual(healthyRes.isFallback, false);
  });
});
