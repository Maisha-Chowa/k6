# Soak testing with k6 — study notes

Based on Grafana’s [Soak testing learning path](https://grafana.com/docs/learning-paths/k6-soak-testing/), reviewed September 12, 2026. Covers all six practical milestones with an adapted script, worked calculations, and a recording template. Example values are not measurements of your application.

Related notes: [Baseline](k6-baseline-study-notes.md) · [System limits](k6-system-limits-study-notes.md) · [Spike testing](k6-spike-testing-study-notes.md).

## 1. What is a soak test?

A **soak test**, also called endurance testing, keeps realistic, moderate traffic running long enough to reveal problems that accumulate over time.

| Test | Main question |
| --- | --- |
| Baseline | How does the service perform under expected traffic? |
| Stress | What happens above normal load? |
| Spike | How does the service respond to and recover from a sudden burst? |
| Soak | Does the service remain healthy when normal traffic continues? |

The key change from average-load testing is duration. The learning path uses a 30-minute hold; real endurance investigations often need several hours or longer. A healthy short run cannot establish stability over a longer period. [Source: Path overview](https://grafana.com/docs/learning-paths/k6-soak-testing/).

## 2. What problems can time reveal?

| Possible problem | Pattern to investigate |
| --- | --- |
| Memory retained unnecessarily | Memory grows; latency or garbage-collection pauses may increase |
| Connections not returned | Pool use accumulates, then requests wait or fail |
| Logs or temporary files fill storage | Gradual disk growth followed by a sudden change |
| Growing backlog or cache-related pressure | Latency slowly increases despite similar traffic |

k6 observes response behavior. Application and infrastructure measurements are needed to establish the cause. Rising memory alone does not prove a leak: a cache may grow and then stabilize. [Source: Soak goals](https://grafana.com/docs/learning-paths/k6-soak-testing/understand-soak-goals/).

## 3. Design the workload

Use the endpoints, request mix, user roles, and pacing from a healthy average-load baseline. Increase the hold duration while keeping the workload comparable.

```text
VU target
 normal        ┌────────────────────────────────────┐
              /              long hold               \
 zero  ──────┘                                        └────
          ramp up                                  ramp down
```

Start with the learning-duration run to verify the workflow, then choose a duration that can expose the suspected failure mechanism. Match production-relevant behavior, including background work and resource usage. [Sources: Profile design](https://grafana.com/docs/learning-paths/k6-soak-testing/design-soak-profile/), [Soak test guide](https://grafana.com/docs/k6/latest/testing-guides/test-types/soak-testing/).

Practical example: a suspected 40 MB/hour leak adds only about 3.3 MB in five minutes but 320 MB over eight hours. The shorter test may not distinguish that from normal variation.

## 4. Complete practice script

Save as `soak.js` in a separate practice directory. This adaptation uses 10 VUs; replace that with your measured average-load concurrency. `HOLD_DURATION` lets you extend the plateau without changing the ramps.

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

const targetUrl = __ENV.TARGET_URL;
if (!targetUrl) throw new Error('Set TARGET_URL to your test endpoint');

export const options = {
  scenarios: {
    soak: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 10 },
        { duration: __ENV.HOLD_DURATION || '30m', target: 10 },
        { duration: '2m', target: 0 },
      ],
    },
  },
  summaryTrendStats: ['avg', 'med', 'max', 'p(95)', 'p(99)'],
  thresholds: {
    http_req_duration: [{
      threshold: 'p(95)<500',
      abortOnFail: true,
      delayAbortEval: '3m',
    }],
    http_req_failed: [{
      threshold: 'rate<0.01',
      abortOnFail: true,
      delayAbortEval: '3m',
    }],
  },
};

export default function () {
  const response = http.get(targetUrl, {
    timeout: '10s',
    tags: { name: 'GET_target' },
  });
  check(response, {
    'status is expected': (r) => r.status === 200,
    'body contains content': (r) =>
      typeof r.body === 'string' && r.body.length > 0,
  });
  sleep(1);
}
```

The null-safe body check avoids throwing when a failed request has no body. Replace it with appropriate business-content checks for your API. [Source: Profile and checks](https://grafana.com/docs/learning-paths/k6-soak-testing/design-soak-profile/).

Default scheduled timeline:

| Elapsed time | VUs | Purpose |
| --- | --- | --- |
| 0:00–2:00 | 0 → 10 | Ramp up |
| 2:00–32:00 | 10 | Soak plateau |
| 32:00–34:00 | 10 → 0 | Ramp down |

`ramping-vus` controls concurrency, not RPS. VUs repeat the test function, including its pause. If responses slow down, the same VUs can complete fewer iterations. Graceful completion may extend execution beyond the scheduled duration. [Source: Ramping VUs](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/ramping-vus/).

Worked estimate: with one request taking 0.25 seconds plus a one-second pause, 10 VUs generate roughly `10 / 1.25 = 8 RPS`. If requests take 1 second, that becomes roughly `10 / 2 = 5 RPS`. Investigate throughput alongside latency and generator health.

## 5. Understand the abort rules

| Setting | Meaning |
| --- | --- |
| `p(95)<500` | p95 must remain strictly below 500 ms |
| `rate<0.01` | HTTP failure fraction must be below 1% |
| `abortOnFail: true` | Stop early when this threshold evaluates as failed |
| `delayAbortEval: '3m'` | Defer early-abort evaluation for three minutes from test start |

Choose limits from your baseline and service objectives. A slow drift can be worth investigating well before it crosses a hard limit. [Source: Soak observability](https://grafana.com/docs/learning-paths/k6-soak-testing/configure-soak-observability/).

The delay does **not** remove warm-up samples or mean “fail continuously for three minutes.” These unfiltered metrics accumulate across the run; they are not a rolling window. A long healthy period can dilute late degradation. Thresholds on cloud-executed tests may take up to 60 seconds to evaluate, so aborts are not precise instantaneous limits.

Checks alone do not fail the process. This script records check results but only enforces the two HTTP thresholds. Add a `checks` threshold when correctness must also determine pass/fail. [Source: Threshold reference](https://grafana.com/docs/k6/latest/using-k6/thresholds/).

## 6. Run and retain a timeline

Replace the URL with your authorized endpoint:

```bash
k6 run -e TARGET_URL='https://your-test-host.example/api/items' soak.js
echo $?
```

For a four-hour plateau, the adapted script supports:

```bash
k6 run -e TARGET_URL='https://your-test-host.example/api/items' -e HOLD_DURATION=4h soak.js
```

The latter schedules 4 hours 4 minutes including ramps. It still uses the script’s three-minute abort delay; adjust that only if the service’s observed warm-up requires it.

For Grafana Cloud, authenticate using the learning path’s pattern:

```bash
k6 cloud login --token <YOUR_API_TOKEN> --stack <YOUR_STACK_SLUG_OR_URL>
```

Keep real tokens out of saved notes and Git. Stream a locally executed run:

```bash
k6 cloud run --local-execution -e TARGET_URL='https://your-test-host.example/api/items' soak.js
```

Open the printed results URL. Local execution uses your machine to generate traffic while Cloud stores and displays results. [Sources: Configure streaming](https://grafana.com/docs/learning-paths/k6-soak-testing/configure-soak-observability/), [Run the soak](https://grafana.com/docs/learning-paths/k6-soak-testing/run-soak-test/).

A local dashboard and HTML export are also available; see the commands in your [spike-testing notes](k6-spike-testing-study-notes.md#4-run-locally-and-view-a-timeline), substituting `soak.js` and `soak-report.html`.

## 7. Monitor comparable windows

Choose a stable reference interval after actual warm-up. Do not assume that a configured delay, or the 15-minute mark, guarantees stability. Compare equally sized intervals at the same plateau load; distinguish the last plateau interval from the lower-load ramp-down.

| k6 observation | Infrastructure evidence to inspect |
| --- | --- |
| Rising latency | Memory, garbage-collection pauses, queues |
| More timeouts or errors | Pool use, file descriptors, downstream health |
| Falling RPS | CPU, I/O wait, request duration |
| Abrupt failure late in the run | Disk availability, logs, resource limits |

Align timestamps. Correlation helps narrow an investigation but does not establish a root cause. If no infrastructure telemetry exists, record response behavior and leave the cause unconfirmed. [Source: Correlate results](https://grafana.com/docs/learning-paths/k6-soak-testing/run-soak-test/).

## 8. Measure onset and drift correctly

Record **onset** as the first sustained change, measured from test start. The path uses failure to return to baseline within five minutes as a teaching definition of sustained change. Adapt that to your service. If the run ends before persistence can be assessed, record that limitation.

Use time-window values to measure drift. Whole-run p95/p99 blend all phases; a passing aggregate does not prove every interval was healthy. If no onset exists, write “not observed,” rather than copying baseline values into an onset column. [Source: Document soak results](https://grafana.com/docs/learning-paths/k6-soak-testing/document-soak-results/).

**Worked calculation — use the interval between observations:**

```text
Drift rate = (later value − earlier value) / elapsed hours between them

p95 at minute 10 = 200 ms
p95 at minute 30 = 320 ms
Elapsed time     = 20 / 60 = 1/3 hour
Drift rate       = 120 / (1/3) = 360 ms/hour
Relative change  = 120 / 200 × 100 = 60%
```

The documentation’s example compares minute 15 with minute 30 but divides by the full 30-minute duration. For 200 → 350 ms across those two observations, the interval is 15 minutes, so the corrected rate is **600 ms/hour**, not 300. Record the selected windows and timestamps explicitly.

This two-point slope summarizes observed change; it is not a reliable forecast that the same slope will continue.

**Errors/hour and error percentage answer different questions.** For example, 60 failures among 6,000 requests is 1%. Sixty failures among 3,000 is 2%. Record counts and request totals for matching windows; a falling RPS can change the percentage even if failures/hour stays constant.

## 9. Record and classify the outcome

| Measurement | Stable reference window | First sustained change | Last plateau window |
| --- | --- | --- | --- |
| Time interval / sample count | | | |
| p95 / p99 | | | |
| HTTP failures / total requests | | | |
| RPS / check pass rate | | | |
| Memory / GC / CPU | | | |
| Pool use / queues / disk | | | |

Also record application and script versions, VUs, hold duration, routes and roles, data size, replica/scaling settings, generator location, onset time, drift rate, and completion reason. Keep suspected causes separate from confirmed findings.

Use categories such as memory-related, connection-related, disk-related, or no degradation observed. When evidence is insufficient, classify the cause as unknown. A clean result means stability was observed for this workload and duration, not indefinite stability. [Source: Result categories](https://grafana.com/docs/learning-paths/k6-soak-testing/document-soak-results/).

## 10. Turn findings into follow-up work

| Evidence suggests | Investigate |
| --- | --- |
| Memory-related growth | Unbounded caches, retained sessions, collections or listeners |
| Connection accumulation | Missing cleanup on error paths, pool utilization |
| Disk pressure | Log rotation, retention, temporary-file cleanup |
| No observed drift | Save the reference; consider extending duration |

Retest changes beyond the previous failure time. Grafana proposes at least twice the observed time-to-degradation as a useful heuristic: if degradation began after 90 minutes, a three-hour rerun provides stronger evidence than a one-hour rerun. This does not guarantee the fix is complete.

Schedule soaks after changes to resource management or infrastructure, before major releases, and at a suitable periodic cadence. [Source: Act on soak results](https://grafana.com/docs/learning-paths/k6-soak-testing/act-on-soak-results/).

Practical preparation for long runs: verify token validity and realistic refresh behavior, sufficient test data and output storage, a stable generator/network, and a machine that will remain awake. Record deployments or scheduled jobs that occur mid-run; otherwise their effects can be mistaken for soak-induced degradation.

## 11. Revision checklist

- [ ] Average-load baseline is healthy.
- [ ] The hold duration can expose the suspected failure mechanism.
- [ ] Request mix, roles, and pacing remain comparable.
- [ ] Timeline and infrastructure evidence are available.
- [ ] Warm-up delay is distinguished from excluding warm-up samples.
- [ ] Early and late windows use the same load and statistics.
- [ ] Drift calculations use the actual interval between observations.
- [ ] Onset, completion reason, limitations, and follow-up are recorded.

1. **Is a soak test simply maximum load for hours?** No; the focus is sustained realistic load.
2. **Can thresholds pass while performance worsens?** Yes; drift can remain below limits or be diluted in aggregate metrics.
3. **Does increasing memory prove a leak?** No; investigate allocation, retention, cleanup, and whether growth stabilizes.
4. **Does constant VU count guarantee constant RPS?** No; longer iterations reduce completed work.
5. **The service was healthy for 30 minutes. Is an eight-hour run unnecessary?** Not if the target failure mechanism needs hours to appear.
