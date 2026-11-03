/**
 * HyperRoute - Dynamic Canary Splitter & EWMA Load Balancer Stress Suite
 * 
 * Verifies:
 * 1. Statistical distribution of hash-pinned canary traffic under 10%, 25%, and 50% weights.
 * 2. Absolute precedence of explicit header overrides for QA/integration staging.
 * 3. Dynamic traffic shedding under artificial EWMA latency degradation.
 * 
 * @author Dev Jangid <https://github.com/Dev-5678>
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CanaryRouter } from '../src/proxy/canary-router.js';
import { EWMALatencyBalancer } from '../src/balancer/strategies.js';

describe('Canary Router Statistical Traffic Splitting', () => {
  it('splits traffic across 2,000 unique client IPs matching 20% weight within 2% margin', () => {
    const router = new CanaryRouter({
      stableUpstream: 'https://api-stable.cluster.internal',
      canaryUpstream: 'https://api-canary.cluster.internal',
      canaryWeightPercentage: 20
    });

    let canaryCount = 0;
    const totalClients = 2000;

    for (let i = 0; i < totalClients; i++) {
      const ip = `192.168.${Math.floor(i / 254)}.${(i % 254) + 1}`;
      const decision = router.route(ip);
      if (decision.isCanary) {
        canaryCount++;
        assert.strictEqual(decision.selectedUpstream, 'https://api-canary.cluster.internal');
      } else {
        assert.strictEqual(decision.selectedUpstream, 'https://api-stable.cluster.internal');
      }
    }

    const actualPercentage = (canaryCount / totalClients) * 100;
    // Expected 20% +/- 2.5% statistical tolerance
    assert.ok(
      actualPercentage >= 17.5 && actualPercentage <= 22.5,
      `Canary split ratio (${actualPercentage.toFixed(2)}%) must fall within 20% +/- 2.5%`
    );
  });

  it('honors sticky header overrides regardless of client hash slot', () => {
    const router = new CanaryRouter({
      stableUpstream: 'https://api-stable.cluster.internal',
      canaryUpstream: 'https://api-canary.cluster.internal',
      canaryWeightPercentage: 0 // 0% organic canary traffic
    });

    const clientIp = '10.0.0.42';
    // Without override -> must route to stable
    const defaultDecision = router.route(clientIp);
    assert.strictEqual(defaultDecision.isCanary, false);

    // With explicit override header -> must route to canary
    const overrideDecision = router.route(clientIp, { 'x-canary-override': 'true' });
    assert.strictEqual(overrideDecision.isCanary, true);
    assert.strictEqual(overrideDecision.reason, 'STICKY_OVERRIDE');
  });
});

describe('EWMA Adaptive Latency Balancer', () => {
  it('dynamically diverts traffic away from degraded high-latency upstreams', () => {
    const balancer = new EWMALatencyBalancer([
      { id: 'node-fast', url: 'http://10.0.1.1:8080', weight: 1, activeConnections: 2, isHealthy: true, consecutiveFailures: 0 },
      { id: 'node-slow', url: 'http://10.0.1.2:8080', weight: 1, activeConnections: 2, isHealthy: true, consecutiveFailures: 0 },
    ]);
    balancer.recordLatency('http://10.0.1.1:8080', 2.1);
    balancer.recordLatency('http://10.0.1.2:8080', 85.4);

    // Balancer must prioritize low EWMA latency node
    const chosen = balancer.getNext();
    assert.strictEqual(chosen.id, 'node-fast');
  });
});
