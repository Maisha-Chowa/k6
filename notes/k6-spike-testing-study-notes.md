# Spike testing with k6 — study notes

Based on Grafana’s [Spike testing learning path](https://grafana.com/docs/learning-paths/k6-spike-testing/), reviewed September 12, 2026. Covers the core workflow and both optional milestones. Scripts and numerical examples below are teaching adaptations, not measurements of your application.

Earlier notes: [Baseline](k6-baseline-study-notes.md) · [System limits](k6-system-limits-study-notes.md).

## 1. What does a spike test measure?

A spike test increases traffic sharply, holds the burst, and then reduces traffic so you can observe recovery. Examples include a product launch, campaign, or sudden redirection of users.

| Test | Main question |
| --- | --- |
| Baseline | Does expected traffic meet performance objectives? |
| Stress | How does performance change as load grows above normal? |
| Breakpoint | Where do selected failure criteria stop an increasing-load test? |
| Spike | What happens during a sudden burst, and how quickly does the service recover? |

The speed of the increase matters as well as the peak. A gradual ramp may give caches, pools, and scaling mechanisms time to adjust; a sharp burst challenges their immediate response. Look for latency, errors such as 429 or 503, and lingering degradation after traffic returns to normal. [Source: Value of spike testing](https://grafana.com/docs/learning-paths/k6-spike-testing/value-of-spike-testing/).

Begin with a healthy baseline and an approved test environment. A successful exercise against a shared demo establishes nothing about your own service’s capacity. [Source: Path overview](https://grafana.com/docs/learning-paths/k6-spike-testing/).

## 2. Understand the traffic shape

```text
VU target
  peak                 ┌──────────┐
                      /            \
  normal      ────────┘              └─────────────────
             baseline     burst          recovery
```

Keep traffic at the original baseline during recovery. Dropping immediately to zero removes the continuing requests you need to judge user-visible performance.

The documentation demonstrates 5 → 100 VUs. The smaller practice example below uses 5 → 25 VUs with a five-second rise. Neither multiplier is a universal requirement. Choose a credible burst size and duration for your workload. [Source: Design a spike profile](https://grafana.com/docs/learning-paths/k6-spike-testing/design-spike-profile/).

## 3. Complete practice script

Save this as `spike.js` in a separate practice directory. Set your endpoint when running it.

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

const targetUrl = __ENV.TARGET_URL;
if (!targetUrl) throw new Error('Set TARGET_URL to your test endpoint');

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      gracefulRampDown: '15s',
      gracefulStop: '15s',
      stages: [
        { duration: '30s', target: 5 },
        { duration: '1m', target: 5 },
        { duration: '5s', target: 25 },
        { duration: '30s', target: 25 },
        { duration: '5s', target: 5 },
        { duration: '3m', target: 5 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  summaryTrendStats: ['avg', 'med', 'max', 'p(95)', 'p(99)'],
  thresholds: {
    http_req_duration: ['p(95)<1500'],
    http_req_failed: ['rate<0.10'],
  },
};

export default function () {
  const response = http.get(targetUrl, {
    timeout: '10s',
    tags: { name: 'GET_target' },
  });
  check(response, {
    'expected status': (r) => r.status === 200,
    'response has content': (r) =>
      typeof r.body === 'string' && r.body.length > 0,
  });
  sleep(1 + Math.floor(Math.random() * 3));
}
```

The random pause is 1, 2, or 3 seconds. Use meaningful response-content checks for your API; an error page can have a nonempty body. The thresholds are illustrative whole-run limits. [Source: Script design](https://grafana.com/docs/learning-paths/k6-spike-testing/design-spike-profile/).

Scheduled timeline for this adapted script:

| Elapsed time | Target VUs | Purpose |
| --- | --- | --- |
| 0:00–0:30 | 0 → 5 | Initial ramp |
| 0:30–1:30 | 5 | Stable baseline reference |
| 1:30–1:35 | 5 → 25 | Sharp increase |
| 1:35–2:05 | 25 | Burst hold |
| 2:05–2:10 | 25 → 5 | Drop toward baseline |
| 2:10–5:10 | 5 | Recovery observation |
| 5:10–5:25 | 5 → 0 | Finish |

`gracefulRampDown` gives retiring VUs time to finish their current iteration; `gracefulStop` permits finishing work after the scenario ends. Actual traffic can therefore trail the scheduled drop. Use the observed timeline when identifying the recovery start, and record interrupted iterations. The scheduled duration is 5 minutes 25 seconds, with possible additional graceful completion time. [Source: Graceful stopping](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/graceful-stop/).

## 4. Run locally and view a timeline

Replace the placeholder with your authorized endpoint:

```bash
k6 run -e TARGET_URL='https://your-test-host.example/api/items' spike.js
echo $?
```

Run `echo $?` immediately after k6. A threshold breach yields a nonzero exit status, typically 99. Read execution errors too; not every failure means the service failed a performance criterion. [Source: Run and interpret results](https://grafana.com/docs/learning-paths/k6-spike-testing/run-spike-test/).

For a local chart and saved HTML report:

```bash
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=spike-report.html k6 run -e TARGET_URL='https://your-test-host.example/api/items' spike.js
```

Open `http://127.0.0.1:5665` during the run. Afterward, open `spike-report.html` for the exported report. Close the dashboard browser tab if k6 remains running after the test while serving dashboard connections. [Source: Web dashboard](https://grafana.com/docs/k6/latest/results-output/web-dashboard/).

## 5. Read the summary carefully

| Measurement | What to examine |
| --- | --- |
| `http_req_duration` | p95/p99 and maximum latency |
| `http_req_failed` | HTTP failure fraction |
| `checks` | Correctness of evaluated conditions |
| `http_reqs` | HTTP request throughput |
| `vus` timeline | Actual load shape |

The end summary combines baseline, burst, and recovery. It cannot tell you when errors occurred or how long recovery took. A passing whole-run p95 threshold does not prove that burst-only p95 passed. Small changes from another run can also be ordinary variation; compare timelines and repeat runs before attributing them to the spike. [Source: Interpreting results](https://grafana.com/docs/learning-paths/k6-spike-testing/run-spike-test/).

Recall from the [baseline notes](k6-baseline-study-notes.md): VUs are not RPS; checks alone do not enforce pass/fail; HTTP failure classification and business correctness are different. This script has no checks threshold and no early-abort rule, so inspect check failures even when the run passes.

Worked example: 1,000 requests with zero failures before/after the burst and 100 burst requests with 30 failures produce a whole-run failure rate of `30 / 1100 = 2.73%`. That passes `<10%`, despite 30% failure during the burst.

## 6. Use Grafana Cloud for stored comparisons

The path’s CLI authentication pattern is:

```bash
k6 cloud login --token <YOUR_API_TOKEN> --stack <YOUR_STACK_SLUG_OR_URL>
```

Replace placeholders with your Cloud details; keep real tokens out of notes and Git. Then:

```bash
k6 cloud run --local-execution -e TARGET_URL='https://your-test-host.example/api/items' spike.js
```

Open the printed results link. Align VUs with latency, errors, and throughput; compare baseline hold, burst, and recovery intervals. Removing `--local-execution` generates traffic on Cloud infrastructure instead. Record generator location and resources when comparing runs. An overloaded local machine can distort measurements. [Source: Visualize in Grafana Cloud](https://grafana.com/docs/learning-paths/k6-spike-testing/visualize-spike-cloud/).

## 7. Measure recovery consistently

The learning path uses a response-time band within 10% of baseline and these teaching categories:

| Category | Observation |
| --- | --- |
| Fast | Returns in less than 30 seconds |
| Slow | Returns in 30 seconds to 3 minutes |
| Not recovered during observation | Remains degraded at the observation window’s end |

These are not k6 defaults or universal SLOs. Pick the same response-time statistic and comparable chart intervals throughout. Whole-run URL percentiles are not per-phase percentiles.

Calculate `recovery time = return-to-normal timestamp − return-to-baseline-load timestamp`. Track errors alongside latency; low latency with ongoing failures is not healthy recovery. [Source: Measure recovery](https://grafana.com/docs/learning-paths/k6-spike-testing/measure-recovery/).

Worked example and practical refinement:

- Baseline interval p95 is 200 ms; an upper tolerance of 10% gives 220 ms.
- Actual load returns to baseline at 2:13.
- p95 returns below 220 ms at 2:48, with failures back to their accepted level.
- Estimated recovery is 35 seconds: slow under the tutorial categories.

Require a chosen stability period, such as 30 seconds, before accepting that return; one healthy chart point can be noise. This stability rule is a suggested refinement, not a built-in k6 behavior. At low baseline traffic, short windows may contain too few samples for reliable tail percentiles.

If performance never deteriorates, record “no observed degradation” instead of inventing a recovery event. If the observation ends first, report “not recovered within 3 minutes,” not “never recovers.”

## 8. Optional: test multiple endpoints

Keep the options, add `group` to the imports, and replace the test function with route-specific requests. Replace the original `targetUrl` declaration and validation with `const baseUrl = __ENV.BASE_URL;` and `if (!baseUrl) throw new Error('BASE_URL is required');`. Set `BASE_URL` without a trailing slash and replace these example routes:

```javascript
// Add group to the existing import from 'k6'.
// Replace the existing default function with this one.
export default function () {
  for (const route of ['/api/items', '/api/categories']) {
    group(route, () => {
      const response = http.get(`${baseUrl}${route}`, {
        tags: { name: `GET ${route}` },
      });
      check(response, { 'route succeeds': (r) => r.status === 200 });
    });
  }
  sleep(1);
}
```

`group()` labels logical work; stable `name` tags support request comparisons. Avoid names containing unique record IDs. The documentation demonstrates a home-page GET plus a pizza API POST; this adaptation uses two GETs. Two sequential requests per iteration change the workload, so establish a matching baseline and compare each route’s burst and recovery behavior. [Source: Multiple endpoints](https://grafana.com/docs/learning-paths/k6-spike-testing/optional-spike-multiple-endpoints/).

## 9. Optional: authenticated APIs

Read credentials from the environment and attach the scheme your API expects. For a bearer-protected target, add this near the top of the script:

```javascript
const token = __ENV.SPIKE_API_TOKEN;
if (!token) throw new Error('SPIKE_API_TOKEN is required');
```

Then add `headers: { Authorization: 'Bearer ' + token }` to the existing HTTP request parameters, preserving its timeout and tags. Keep real credentials in your shell session or secret store, not source code. The main single-endpoint script still uses `TARGET_URL`.

Confirm correct credentials and status expectations before a spike. A service rejecting every request at authentication is not exercising the intended business operation. QuickPizza’s demo API uses a `Token` scheme; it is not a general bearer-token example. [Source: Authentication](https://grafana.com/docs/learning-paths/k6-spike-testing/optional-spike-authenticated-requests/).

## 10. Record findings and choose an action

| Field | Your result |
| --- | --- |
| Date, application/script/k6 version | |
| Environment, replicas, scaling settings | |
| Generator location and resources | |
| Routes, roles, test data, pause pattern | |
| Baseline VUs → peak VUs; rise/hold/drop durations | |
| Baseline, burst, recovery latency and error metrics | |
| Measured RPS in each phase | |
| Recovery definition, window size, sample counts | |
| Actual load-drop time / stable-recovery time | |
| Recovery category / threshold and check results | |
| CPU, memory, queues, database, alerts | |
| Follow-up owner and retest condition | |

| Finding | Follow-up to investigate |
| --- | --- |
| Fast recovery | More representative routes or a larger justified burst |
| Slow recovery | Pool contention, queue drainage, scaling readiness |
| No recovery within the window | Resource retention, downstream failures, load shedding |

These are investigation directions, not proven root causes. Compare the observed disruption with your SLOs, and verify that expected alerts fired. Repeat after major changes and before anticipated traffic events; choose a periodic cadence appropriate to the service. A single spike recovery measurement is not an incident MTTR average. [Source: Turn results into action](https://grafana.com/docs/learning-paths/k6-spike-testing/act-on-results/).

## 11. Quick revision

- [ ] Baseline traffic continues after the burst.
- [ ] Burst size and timing match a plausible scenario.
- [ ] A timeline is saved, not just a final summary.
- [ ] Recovery uses consistent latency statistics and acceptable errors.
- [ ] Whole-run threshold success is distinguished from phase health.
- [ ] Generator limitations and actual load-drop timing are checked.
- [ ] Results lead to a specific investigation or retest.

1. **Does passing p95 prove recovery was fast?** No; recovery requires time-based analysis.
2. **Why continue baseline load after the burst?** To observe whether ordinary requests return to normal behavior.
3. **Is a 20× VU increase necessarily 20× RPS?** No; response time and iteration pacing affect throughput.
4. **Latency recovered but errors remained high. Is the service healthy?** No; assess both speed and correctness.
5. **Does a healthy burst identify maximum capacity?** No; it establishes a successful tested case.
