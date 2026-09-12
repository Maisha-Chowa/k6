# Find system limits with k6 — study notes

Based on Grafana’s [Find your system’s limits learning path](https://grafana.com/docs/learning-paths/find-k6-limits/), reviewed September 12, 2026. This note covers all its milestones, with adapted practice scripts and interpretation tips. All example numbers are illustrative, not results from your application.

Previous topic: [Establish a k6 baseline](k6-baseline-study-notes.md).

## 1. What are you trying to discover?

| Test | Main question | Result |
| --- | --- | --- |
| Baseline | How does the service behave at expected traffic? | Healthy reference measurements |
| Stress | What happens above expected traffic? | Where and how performance deteriorates |
| Breakpoint | At what increasing load do chosen failure limits get crossed? | An approximate boundary for this workload and configuration |

Start after your baseline passes. Breakpoint testing is optional: the learning path calls for a dedicated test environment and disabling autoscaling on components whose fixed capacity you want to measure. A shared demo can teach mechanics, but its results do not describe your application. [Source: Path overview](https://grafana.com/docs/learning-paths/find-k6-limits/).

The useful output is a **capacity envelope**: the tested range where the service is healthy, where it degrades, and where the test reaches its stopping criteria.

## 2. Recognize overload patterns

| Pattern | What you might observe | What to investigate |
| --- | --- | --- |
| Gradual degradation | Latency increases with load | Growing queues or resource contention |
| Sudden failure | Errors jump at one load level | A resource or connection limit |
| Cascading failure | Several dependent operations deteriorate together | Shared dependencies and propagation of failures |

These are investigation clues, not diagnoses. Correlate them with server and database telemetry.

Grafana’s 2× and 3× baseline stages are teaching examples. There is no universal stress multiplier; use credible overload scenarios for your service. [Source: Value of stress testing](https://grafana.com/docs/learning-paths/find-k6-limits/stress-vs-baseline/).

## 3. VU ramps versus arrival-rate ramps

| Executor | You control | When responses slow down |
| --- | --- | --- |
| `ramping-vus` | Concurrent virtual users | Each user completes fewer iterations |
| `ramping-arrival-rate` | Iteration starts per time unit | More VUs are needed to maintain the schedule |

An **iteration** is one execution of the test function. Arrival rate means iteration starts, not guaranteed successful requests. With one HTTP call per iteration and no additional requests, it approximates offered request rate. Multi-request flows and redirects change that relationship.

Arrival-rate executors already pace iteration starts. Do not add a final `sleep()` just to control their rate. [Source: Ramping arrival rate](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/ramping-arrival-rate/).

Worked example: 20 users each making one request in 0.5 seconds and then sleeping for 1 second generate roughly `20 / 1.5 = 13.3 RPS`. If the request takes 3 seconds, that becomes roughly `20 / 4 = 5 RPS`. A fixed VU count therefore does not maintain fixed pressure in RPS.

## 4. Practice stress script

Save as `stress.js` in a separate practice directory. This adapts the path’s profile to a hypothetical 10-VU baseline. Keep your real workload, authentication, and correctness checks consistent with your baseline.

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

const targetUrl = __ENV.TARGET_URL;
if (!targetUrl) throw new Error('Set TARGET_URL to your test endpoint');

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 10 },
        { duration: '1m', target: 10 },
        { duration: '20s', target: 20 },
        { duration: '1m', target: 20 },
        { duration: '20s', target: 30 },
        { duration: '1m', target: 30 },
        { duration: '20s', target: 0 },
      ],
    },
  },
  summaryTrendStats: ['avg', 'med', 'max', 'p(95)', 'p(99)'],
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.05'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const response = http.get(targetUrl, { timeout: '10s' });
  check(response, {
    'status is expected': (r) => r.status === 200,
    'body has content': (r) =>
      typeof r.body === 'string' && r.body.length > 0,
  });
  sleep(1);
}
```

The scheduled profile lasts 4 minutes 20 seconds, plus any graceful completion time. Each target is the total VU count to reach. Holds give elevated traffic time to reveal strain. Thresholds here are examples to replace with your own criteria. [Source: Design a stress profile](https://grafana.com/docs/learning-paths/find-k6-limits/design-stress-profile/).

## 5. Run and observe

Replace the URL with your authorized test endpoint:

```bash
k6 run --out json=stress-points.json -e TARGET_URL='https://your-test-host.example/api/items' stress.js
echo $?
```

JSON output stores timestamped metric samples. You can instead stream to Grafana Cloud after configuring authentication:

```bash
k6 cloud run --local-execution -e TARGET_URL='https://your-test-host.example/api/items' stress.js
```

The local-execution option generates traffic on your machine while sending results to Cloud. Use a timeline to correlate load and performance. [Sources: Real-time output](https://grafana.com/docs/k6/latest/results-output/real-time/), [Document results](https://grafana.com/docs/learning-paths/find-k6-limits/document-stress-results/).

Watch for rising p95/p99, HTTP failures, failed content checks, connection resets, and timeouts. A plateau or fall in throughput alongside worsening latency deserves investigation. Error messages alone do not prove which component failed.

A healthy run through every stage is valid: report the highest tested load as healthy under those conditions. You have not discovered a failure boundary. [Source: Observe degradation](https://grafana.com/docs/learning-paths/find-k6-limits/run-stress-test/).

## 6. Record results by stage

| Measurement | Baseline hold | Middle stress hold | Highest stress hold |
| --- | --- | --- | --- |
| VUs | 10 | 20 | 30 |
| Measured HTTP RPS | | | |
| p95 / p99 | | | |
| HTTP failure percentage | | | |
| Check pass percentage | | | |
| CPU / memory / database observations | | | |

Use interval data for each column. The final terminal summary combines the full run; it does not supply separate stage percentiles. Repeat the profile two or three times to check consistency. Record either the first unacceptable stage or that no degradation appeared within the tested range. [Source: Document the stress result](https://grafana.com/docs/learning-paths/find-k6-limits/document-stress-results/).

Practical interpretation: if 20 VUs were healthy and 30 were unhealthy, you have bounded the transition between tested workloads. Run finer steps to narrow it; do not claim the exact limit is 30.

## 7. Practice breakpoint script

Save as `breakpoint.js`. This uses a smaller teaching ramp than the documentation: 0 → 50 iteration starts/second over 3 minutes. These settings are not a capacity recommendation.

```javascript
import http from 'k6/http';
import { check } from 'k6';

const targetUrl = __ENV.TARGET_URL;
if (!targetUrl) throw new Error('Set TARGET_URL to your dedicated test endpoint');

export const options = {
  scenarios: {
    breakpoint: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 300,
      stages: [{ duration: '3m', target: 50 }],
    },
  },
  summaryTrendStats: ['avg', 'med', 'max', 'p(95)', 'p(99)'],
  thresholds: {
    http_req_duration: [{
      threshold: 'p(95)<2000',
      abortOnFail: true,
      delayAbortEval: '30s',
    }],
    http_req_failed: [{
      threshold: 'rate<0.20',
      abortOnFail: true,
      delayAbortEval: '30s',
    }],
  },
};

export default function () {
  const response = http.get(targetUrl, { timeout: '10s' });
  check(response, {
    'status is expected': (r) => r.status === 200,
    'body has content': (r) =>
      typeof r.body === 'string' && r.body.length > 0,
  });
}
```

This stops on the selected latency or HTTP-failure conditions. Checks remain diagnostic here because there is no checks threshold. A nonempty body is only a practice check; add application-specific validation. [Source: Build a breakpoint script](https://grafana.com/docs/learning-paths/find-k6-limits/build-breakpoint-script/).

| Setting | Meaning |
| --- | --- |
| `startRate: 0` | Begin at zero scheduled iteration starts |
| `timeUnit: '1s'` | Interpret rate targets per second |
| `target: 50` | Reach 50 scheduled starts/second at the stage’s end |
| `preAllocatedVUs: 100` | Reserve 100 VUs before execution |
| `maxVUs: 300` | Allow allocation up to 300 VUs |

Available VUs must be sufficient to deliver the schedule. Allocation settings are not a promise that the target rate will be achieved. [Source: Executor options](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/ramping-arrival-rate/).

## 8. Understand the stopping rules

- `p(95)<2000`: p95 must be strictly below 2 seconds.
- `rate<0.20`: fewer than 20% of HTTP requests may fail.
- `abortOnFail: true`: stop early when that threshold evaluates as failed.
- `delayAbortEval: '30s'`: defer early abort evaluation for 30 seconds from the start.

The delay is not a requirement for 30 consecutive seconds of failure, and does not discard early samples. Ordinary string thresholds, as in the stress example, determine pass/fail without automatically aborting. Checks alone do not fail a run. [Source: Threshold behavior](https://grafana.com/docs/k6/latest/using-k6/thresholds/).

These unfiltered thresholds evaluate accumulated metrics, not a rolling last-30-second window. Consequently, early healthy traffic can delay detection of later degradation. Treat the abort point as dependent on ramp speed, measurement scope, and chosen limits.

## 9. Run and identify what actually stopped the test

```bash
k6 run --out json=breakpoint-points.json -e TARGET_URL='https://your-dedicated-test-host.example/api/items' breakpoint.js
echo $?
```

Record whether the run ended through a threshold abort, completed its ramp, was manually stopped, or encountered an execution error. A threshold stop identifies failure of your criteria; it does not necessarily mean the application crashed. A completed ramp without a breach means the boundary was not found in that range. [Source: Run the breakpoint test](https://grafana.com/docs/learning-paths/find-k6-limits/run-breakpoint-test/).

**Distinguish these measurements:**

| Measurement | How to interpret it |
| --- | --- |
| Scheduled arrival rate | What the executor attempted to start |
| Actual HTTP RPS | Requests recorded in a chosen interval; includes failures |
| Successful throughput | Successful requests in that same interval |
| `vus` | Active VUs |
| `vus_max` | Available VU capacity; not actual concurrency at abort |
| `dropped_iterations` | Scheduled iterations that could not start |

The final summary’s RPS is a whole-run average, not instantaneous RPS at the stop. Get stop-time rates and active VUs from timestamped data. [Sources: Built-in metrics](https://grafana.com/docs/k6/latest/using-k6/metrics/reference/), [Real-time output](https://grafana.com/docs/k6/latest/results-output/real-time/).

Worked example: this script’s linear ramp schedules `50 × 90 / 180 = 25` starts/second at 90 seconds. The average scheduled rate over those first 90 seconds is only 12.5/second. Neither figure proves the achieved request rate.

## 10. Check whether the generator kept up

Arrival-rate iterations are dropped when no VU is free to start them. Drops from the beginning can indicate insufficient allocation. Drops appearing as latency rises can mean slower responses are tying up the available VUs. Investigate both test configuration and service performance. [Source: Dropped iterations](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/dropped-iterations/).

Practical sizing estimate: `required busy VUs ≈ starts/second × iteration duration in seconds`. At 50 starts/second and 2-second iterations, roughly 100 VUs are busy. Allow additional headroom for variation. Also inspect the generator’s CPU, memory, and network before attributing a ceiling solely to the service.

## 11. Map the findings to operating decisions

| Zone | Interpretation |
| --- | --- |
| Normal | Tested workload meets the service’s objectives |
| Degrading | Response quality or speed becomes unacceptable |
| Breakpoint boundary | Selected stop criteria are crossed |

Keep normal traffic below observed degradation with room to react. Use results to propose an autoscaling trigger, an alert, or revised traffic headroom. Grafana’s percentage margins are examples, not universal settings. Revalidate after infrastructure or dependency changes. If no boundary was observed, label it unknown. [Source: Capacity envelope](https://grafana.com/docs/learning-paths/find-k6-limits/map-capacity-envelope/).

Practical example: suppose repeated tests first violate your SLO near 80 measured RPS. A candidate scaling trigger at 60 RPS leaves 25% traffic headroom relative to 80. Validate whether scaling finishes before traffic reaches the unhealthy range. Translate VU findings into measurable service signals; production does not inherently expose “k6 VUs.”

Record application/script versions, server resources, replica count, scaling configuration, request mix, roles, data size, cache state, generator location, and analysis window with every result. Add a recovery observation after reducing load: did latency, errors, and queues return to normal?

## 12. Revision checklist and questions

- [ ] Baseline passes before stress testing.
- [ ] Overload targets represent a meaningful scenario.
- [ ] Stage measurements come from matching time windows.
- [ ] Breakpoint work uses a dedicated environment.
- [ ] Stop criteria and completion reason are recorded.
- [ ] Scheduled rate, actual rate, and dropped work are distinguished.
- [ ] Generator limitations have been investigated.
- [ ] Findings support one concrete operating decision.

1. **All stress stages passed. Did I find maximum capacity?** No; only a tested healthy range.
2. **The summary says 25 RPS. Was that the rate at abort?** Not necessarily; inspect the stop interval.
3. **The arrival target is 50. Does that mean 50 VUs?** No; it means 50 iteration starts per configured time unit.
4. **Why omit final sleep in the breakpoint script?** The executor already schedules starts; sleep consumes VU time without providing necessary pacing.
5. **The test aborts at 20% errors. Should normal traffic operate there?** No; that is a chosen failure boundary, not an operating target.
6. **HTTP RPS increased but successful RPS decreased. Is capacity improving?** No; extra error responses can inflate total throughput.
