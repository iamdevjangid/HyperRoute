/**
 * HyperRoute - Prometheus Observability & Latency Percentiles Test Suite
 * 
 * Verifies:
 * 1. Counter incrementation with multi-dimensional route, method, and status labels.
 * 2. Sliding window p50, p95, and p99 latency quantile calculations.
 * 3. Accurate 429 rate-limiting rejection counters.
 * 4. Compliant OpenMetrics / Prometheus exposition text formatting.
 * 5. Bounded memory eviction under high-volume latency ingestion.
 * 
 * @author Dev Jangid <https://github.com/Dev-5678>
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PrometheusMetrics } from '../src/metrics/prometheus.js';

describe('HyperRoute - Prometheus Observability & Metrics Exporter', () => {
  it('correctly tracks request counters partitioned by method, path, and status code', () => {
    const metrics = new PrometheusMetrics();

    metrics.recordRequest('GET', '/api/v1/users', 200, 1.2);
    metrics.recordRequest('GET', '/api/v1/users', 200, 1.5);
    metrics.recordRequest('POST', '/api/v1/users', 201, 3.4);
    metrics.recordRequest('GET', '/api/v1/users', 404, 0.8);

    const exported = metrics.exportOpenMetrics();

    assert.ok(exported.includes('hyperroute_requests_total{method="GET",path="/api/v1/users",status="200"} 2'));
    assert.ok(exported.includes('hyperroute_requests_total{method="POST",path="/api/v1/users",status="201"} 1'));
    assert.ok(exported.includes('hyperroute_requests_total{method="GET",path="/api/v1/users",status="404"} 1'));
  });

  it('accurately computes p50, p95, and p99 latency quantiles', () => {
    const metrics = new PrometheusMetrics();

    // Ingest 100 deterministic latencies: 1ms to 100ms
    for (let i = 1; i <= 100; i++) {
      metrics.recordRequest('GET', '/bench', 200, i);
    }

    const p50 = metrics.getPercentile(50);
    const p95 = metrics.getPercentile(95);
    const p99 = metrics.getPercentile(99);

    assert.strictEqual(p50, 50);
    assert.strictEqual(p95, 95);
    assert.strictEqual(p99, 99);
  });

  it('tracks 429 rate limit rejection counter separately', () => {
    const metrics = new PrometheusMetrics();

    metrics.recordRateLimitRejection();
    metrics.recordRateLimitRejection();
    metrics.recordRateLimitRejection();

    const exported = metrics.exportOpenMetrics();
    assert.ok(exported.includes('hyperroute_ratelimit_rejections_total 3'));
  });

  it('generates compliant OpenMetrics exposition text with valid HELP and TYPE descriptors', () => {
    const metrics = new PrometheusMetrics();
    metrics.recordRequest('GET', '/health', 200, 0.4);

    const output = metrics.exportOpenMetrics();

    assert.ok(output.includes('# HELP hyperroute_requests_total'));
    assert.ok(output.includes('# TYPE hyperroute_requests_total counter'));
    assert.ok(output.includes('# HELP hyperroute_latency_ms'));
    assert.ok(output.includes('# TYPE hyperroute_latency_ms gauge'));
    assert.ok(output.includes('quantile="0.50"'));
    assert.ok(output.includes('quantile="0.99"'));
  });

  it('bounds latency sliding window to 10,000 samples to prevent memory leaks', () => {
    const metrics = new PrometheusMetrics();

    // Ingest 12,000 samples
    for (let i = 0; i < 12000; i++) {
      metrics.recordRequest('GET', '/stream', 200, 1.0);
    }

    // Access private field to verify length is bounded
    const sampleCount = (metrics as unknown as { latencies: number[] }).latencies.length;
    assert.strictEqual(sampleCount, 10000);
  });
});
