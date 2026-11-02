/**
 * HyperRoute - Graceful Upstream Drain & Zero-Downtime Node Eviction Test Suite
 *
 * Verifies non-disruptive rolling deployment guarantees by ensuring upstreams in
 * DRAINING state accept zero new ingress requests while gracefully allowing all
 * active in-flight requests to complete within the configured drain deadline.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

export type NodeState = 'ACTIVE' | 'DRAINING' | 'TERMINATED';

export interface UpstreamEndpoint {
  id: string;
  url: string;
  state: NodeState;
  activeInflightRequests: number;
  drainInitiatedAt: number | null;
  drainTimeoutMs: number;
}

export class GracefulDrainManager {
  private nodes: Map<string, UpstreamEndpoint> = new Map();
  private defaultDrainTimeoutMs: number;

  constructor(options: { defaultDrainTimeoutMs?: number } = {}) {
    this.defaultDrainTimeoutMs = options.defaultDrainTimeoutMs ?? 5000;
  }

  public registerNode(id: string, url: string, drainTimeoutMs?: number): void {
    this.nodes.set(id, {
      id,
      url,
      state: 'ACTIVE',
      activeInflightRequests: 0,
      drainInitiatedAt: null,
      drainTimeoutMs: drainTimeoutMs ?? this.defaultDrainTimeoutMs,
    });
  }

  public getNode(id: string): UpstreamEndpoint | undefined {
    return this.nodes.get(id);
  }

  public selectEligibleUpstream(): UpstreamEndpoint | null {
    let candidate: UpstreamEndpoint | null = null;
    let minInflight = Infinity;

    for (const node of this.nodes.values()) {
      if (node.state === 'ACTIVE') {
        if (node.activeInflightRequests < minInflight) {
          minInflight = node.activeInflightRequests;
          candidate = node;
        }
      }
    }

    return candidate;
  }

  public acquireLease(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node || node.state !== 'ACTIVE') {
      return false;
    }
    node.activeInflightRequests++;
    return true;
  }

  public releaseLease(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    if (node.activeInflightRequests > 0) {
      node.activeInflightRequests--;
    }

    if (node.state === 'DRAINING' && node.activeInflightRequests === 0) {
      node.state = 'TERMINATED';
    }
  }

  public initiateDrain(nodeId: string, now = Date.now()): boolean {
    const node = this.nodes.get(nodeId);
    if (!node || node.state === 'TERMINATED') {
      return false;
    }

    node.state = 'DRAINING';
    node.drainInitiatedAt = now;

    if (node.activeInflightRequests === 0) {
      node.state = 'TERMINATED';
    }

    return true;
  }

  public sweepExpiredDrains(now = Date.now()): string[] {
    const forcedEvictions: string[] = [];

    for (const [id, node] of this.nodes.entries()) {
      if (node.state === 'DRAINING' && node.drainInitiatedAt !== null) {
        const elapsed = now - node.drainInitiatedAt;
        if (elapsed >= node.drainTimeoutMs) {
          node.state = 'TERMINATED';
          node.activeInflightRequests = 0;
          forcedEvictions.push(id);
        }
      }
    }

    return forcedEvictions;
  }
}

describe('HyperRoute - Graceful Upstream Drain & Node Eviction', () => {
  it('should route new ingress traffic exclusively to ACTIVE nodes', () => {
    const manager = new GracefulDrainManager();
    manager.registerNode('node-1', 'http://upstream-1:8080');
    manager.registerNode('node-2', 'http://upstream-2:8080');

    const selected = manager.selectEligibleUpstream();
    assert.ok(selected !== null);
    assert.strictEqual(selected.state, 'ACTIVE');
  });

  it('should immediately disallow lease acquisition on DRAINING nodes', () => {
    const manager = new GracefulDrainManager();
    manager.registerNode('node-1', 'http://upstream-1:8080');
    
    // Acquire 2 active leases
    assert.strictEqual(manager.acquireLease('node-1'), true);
    assert.strictEqual(manager.acquireLease('node-1'), true);
    assert.strictEqual(manager.getNode('node-1')?.activeInflightRequests, 2);

    // Initiate graceful drain
    const drainStarted = manager.initiateDrain('node-1');
    assert.strictEqual(drainStarted, true);
    assert.strictEqual(manager.getNode('node-1')?.state, 'DRAINING');

    // New ingress lease must be rejected
    assert.strictEqual(manager.acquireLease('node-1'), false);
    assert.strictEqual(manager.selectEligibleUpstream(), null);
  });

  it('should automatically transition to TERMINATED once inflight drops to zero', () => {
    const manager = new GracefulDrainManager();
    manager.registerNode('node-1', 'http://upstream-1:8080');
    
    manager.acquireLease('node-1');
    manager.initiateDrain('node-1');
    assert.strictEqual(manager.getNode('node-1')?.state, 'DRAINING');

    // Release remaining lease
    manager.releaseLease('node-1');
    assert.strictEqual(manager.getNode('node-1')?.activeInflightRequests, 0);
    assert.strictEqual(manager.getNode('node-1')?.state, 'TERMINATED');
  });

  it('should immediately terminate an idle node with zero active inflight requests upon drain', () => {
    const manager = new GracefulDrainManager();
    manager.registerNode('node-idle', 'http://upstream-idle:8080');

    manager.initiateDrain('node-idle');
    assert.strictEqual(manager.getNode('node-idle')?.state, 'TERMINATED');
  });

  it('should enforce hard deadline eviction when drain timeout expires', () => {
    const manager = new GracefulDrainManager({ defaultDrainTimeoutMs: 3000 });
    manager.registerNode('node-stuck', 'http://upstream-stuck:8080');

    manager.acquireLease('node-stuck');
    const startTime = 1000000;
    manager.initiateDrain('node-stuck', startTime);

    // At t + 2000ms: still within timeout
    const earlyEvictions = manager.sweepExpiredDrains(startTime + 2000);
    assert.strictEqual(earlyEvictions.length, 0);
    assert.strictEqual(manager.getNode('node-stuck')?.state, 'DRAINING');

    // At t + 3500ms: timeout exceeded
    const forced = manager.sweepExpiredDrains(startTime + 3500);
    assert.deepStrictEqual(forced, ['node-stuck']);
    assert.strictEqual(manager.getNode('node-stuck')?.state, 'TERMINATED');
    assert.strictEqual(manager.getNode('node-stuck')?.activeInflightRequests, 0);
  });
});
