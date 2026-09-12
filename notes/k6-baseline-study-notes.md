# Establish a k6 baseline — study notes
## 1. What is a baseline?

A **performance baseline** records how a healthy application behaves under a specific, realistic workload. Future tests use it as a comparison point.

Record three things together:

| Measurement | Question it answers | Example |
| Latency | How quickly do requests finish? | p95 = 300 ms |
| Throughput | How much traffic is handled? | 16 requests/second |
| Error rate | How often do requests fail? | 0% |

**p95 = 300 ms** means approximately 95% of sampled requests took 300 ms or less; about 5% took longer. **p99** is the boundary near the slowest 1%, not the average of that 1%. An average can hide a small group of very slow requests.

A baseline is an observation. A threshold is an acceptance rule. An SLO is a service objective. An observed result can help choose a rule, but does not automatically establish an acceptable user experience. 
## 2. Choose realistic traffic

A **VU**, or virtual user, independently repeats your test function. An **iteration** is one execution of that function. Your function might make one request or several.

Use three stages: increase traffic, hold a stable workload, then decrease traffic. The `stages` option selects the `ramping-vus` executor automatically. Each `target` is the VU count to reach at the end of that stage; it is not an additional number of users.

Example profile used in these notes:

| Time      | Active VUs | Purpose |
| 0–20 seconds | 0 → 10 | Ramp up |
| 20–140 seconds | 10 | Hold |
| 140–160 seconds | 10 → 0 | Ramp down |

Choose user counts and request patterns from actual usage. The hold should be long enough for stable measurements; a short tutorial hold is not proof of long-term stability. 

**Worked reasoning:** With one sequential request taking 0.25 seconds plus a 1-second pause, one iteration takes roughly 1.25 seconds. Ten VUs would generate roughly `10 / 1.25 = 8 RPS`, ignoring other overhead. Thus, 10 VUs does not mean 10 RPS. If responses slow down, these VUs complete fewer iterations.

## 3. Checks validate correctness

A check evaluates a condition, such as an expected status or required response content. A failed check is recorded and normally allows execution to continue. It does not, by itself, make the run fail.

Two checks per response produce two check results. If 100 responses all pass the status check but 10 fail the body check, the combined pass rate is `190 / 200 = 95%`, even though only 90% of responses passed both.

Use meaningful application checks: a nonempty body alone could be an error page. For a real JSON API, validate required fields or business values. [Source: Checks](https://grafana.com/docs/learning-paths/establish-k6-baseline/add-checks/).

## 4. A complete practice script

Save this as `baseline.js` in a separate practice directory. It requires a target URL so you choose what receives traffic. Run against a service you are authorized to test.

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

const targetUrl = __ENV.TARGET_URL;
if (!targetUrl) throw new Error('Set TARGET_URL to your test endpoint');

// First measure without gates; enable them after choosing your limits.
const enforce = __ENV.ENFORCE === 'true';

export const options = {
  scenarios: {
    baseline: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 10 },
        { duration: '2m', target: 10 },
        { duration: '20s', target: 0 },
      ],
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  // Illustrative limits: replace with justified acceptance criteria.
  thresholds: enforce ? {
    http_req_duration: ['p(95)<400'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate==1'],
  } : {},
};

export default function () {
  const response = http.get(targetUrl, { timeout: '10s' });
  check(response, {
    'expected status': (r) => r.status === 200,
    'has response content': (r) =>
      typeof r.body === 'string' && r.body.length > 0,
  });
  sleep(1);
}
```

`http.get()` sends the request; `check()` evaluates the returned response; `sleep(1)` pauses that VU for one second. Change the status/content checks to match your endpoint’s contract.

`summaryTrendStats` adds p99 to the displayed statistics; it does not create a p99 pass/fail rule. Environment variables provided with `-e` are read through `__ENV`. [Source: Options reference](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/).

## 5. Run and read the result

With k6 already installed, run from the directory containing your practice file. Replace the placeholder URL:

```bash
k6 version
k6 run -e TARGET_URL='https://your-test-host.example/api/items' baseline.js
```

Review latency, failures, and check results before accepting a run as healthy. Terminal formatting varies by k6 version. [Source: Run and read results](https://grafana.com/docs/learning-paths/establish-k6-baseline/run-and-read-results/).

| Metric | Meaning |
| --- | --- |
| `http_req_duration` | Sending + waiting + receiving time; excludes initial DNS/connection setup |
| `http_reqs` | HTTP request count; its per-second value is request throughput |
| `http_req_failed` | Fraction of requests classified as failures |
| `iterations` | Completed executions of the test function |
| `iteration_duration` | Time spent in an iteration, including its pauses |
| `checks` | Fraction of check evaluations that passed |

Use `http_reqs` for RPS. Iterations/second equals requests/second only when each completed iteration corresponds to one HTTP request, with no extra requests affecting the count. Redirects and multi-request flows can break that equivalence. [Source: Built-in metrics](https://grafana.com/docs/k6/latest/using-k6/metrics/reference/).

**HTTP failure detail:** k6 accepts status codes 200–399 by default. A custom check requiring exactly 200 can fail even when `http_req_failed` does not. Expected-status behavior can be customized with `http.setResponseCallback(http.expectedStatuses(...))`. An HTTP 200 with incorrect business data also needs a content check. [Source: Response classification](https://grafana.com/docs/k6/latest/javascript-api/k6-http/set-response-callback/).

## 6. Record a trustworthy baseline

Take latency, request failure rate, and throughput from healthy runs. Allow reasonable variation when choosing thresholds: Grafana gives 20–50% latency headroom as an example, not a universal requirement. If p95 is 300 ms, 30% headroom gives 390 ms. Check that the chosen limit still meets the service’s requirements. [Source: Identify baseline values](https://grafana.com/docs/learning-paths/establish-k6-baseline/identify-baseline-values/).

Practical recording template:

| Field | Your value |
| --- | --- |
| Date, application version, k6 version | |
| Environment and server resources | |
| Load-generator machine and location | |
| Endpoints, request mix, authentication/roles | |
| Test-data size and cache state | |
| VUs, stages, pause duration | |
| Measurement window: whole run or hold only | |
| p95 / p99 | |
| RPS / HTTP failure rate / check pass rate | |
| CPU, memory, database observations | |
| Result location and chosen thresholds | |

Practical procedure: repeat the same profile several times and record the spread before selecting a reference run. If the results vary greatly, investigate the variation first.

**Measurement-window caution:** the ordinary summary and the script’s unfiltered thresholds aggregate the whole run, including ramps. They do not automatically isolate the two-minute hold. For a hold-only baseline, select that interval in time-series results or use a separately designed steady-load measurement. Always compare the same window. This is also noted in this project’s [README](../README.md#interpret-the-result).

## 7. Turn observations into thresholds

| Expression | Exact passing condition |
| --- | --- |
| `p(95)<400` | p95 strictly below 400 ms |
| `rate<0.01` on `http_req_failed` | Fewer than 1% failed HTTP requests |
| `rate>0.99` on `checks` | More than 99% of check evaluations pass |
| `rate==1` on `checks` | Every check evaluation passes |

Equality fails strict comparisons: p95 of exactly 400 ms fails `<400`; exactly 1% failures fails `<0.01`. `rate>0.99` concerns check success, not p99 latency.

Threshold breaches make the run fail with a nonzero exit status. Basic thresholds do not automatically stop the run early. [Source: Thresholds](https://grafana.com/docs/learning-paths/establish-k6-baseline/add-thresholds/).

After adjusting the practice script’s limits:

```bash
k6 run -e TARGET_URL='https://your-test-host.example/api/items' -e ENFORCE=true baseline.js
echo $?
```

Run `echo $?` immediately after k6. A successful run returns 0. For a deliberate failure exercise, temporarily change the latency condition to `p(95)<0`; a run producing HTTP timing samples should fail that impossible negative-duration condition. Threshold failure normally returns 99. Restore your real limit afterward. Other nonzero codes can indicate execution errors, so also read the output. [Source: Validate thresholds](https://grafana.com/docs/learning-paths/establish-k6-baseline/validate-thresholds/).

## 8. Save results for later comparison

Keep the recording table with the script version. For an optional local time-series file:

```bash
k6 run --out json=baseline-points.json -e TARGET_URL='https://your-test-host.example/api/items' baseline.js
```

This output contains metric samples, not just one summary object. [Source: Results output option](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/#results-output).

Grafana Cloud can store run history and display timelines, checks, and thresholds. The learning path’s authentication command is:

```bash
k6 cloud login --token <YOUR_API_TOKEN> --stack <YOUR_STACK_SLUG>
```

Replace placeholders with your Cloud credentials; keep the token out of saved notes and version control. Then run locally while streaming results:

```bash
k6 cloud run --local-execution -e TARGET_URL='https://your-test-host.example/api/items' baseline.js
```

Without `--local-execution`, `k6 cloud run` executes on Cloud infrastructure. A different generator location can change latency, so record it when comparing runs. [Source: Cloud results](https://grafana.com/docs/learning-paths/establish-k6-baseline/save-share-results/).

## 9. Revision checklist

- [ ] My traffic represents a real workload.
- [ ] My checks verify meaningful correctness.
- [ ] Healthy repeated runs give reasonably consistent measurements.
- [ ] I recorded p95, p99, RPS, failures, and test conditions.
- [ ] I know whether my measurements include ramp stages.
- [ ] Thresholds reflect justified limits, not copied example numbers.
- [ ] I verified both a passing run and an intentional threshold failure.
- [ ] Results and script version are saved for comparison.

## 10. Test your understanding

1. **p95 is 250 ms. Did every request finish within 250 ms?** No; approximately 5% were slower.
2. **A status check fails. Must the process exit with failure?** No; add a suitable threshold to enforce check results.
3. **One iteration makes three requests. Is 10 iterations/second necessarily 10 RPS?** No; it is roughly 30 RPS in a stable run without additional requests.
4. **p95 increased from 300 to 360 ms. What is the change?** `(360 - 300) / 300 × 100 = 20%` slower. Passing a 400 ms threshold does not erase that regression.
5. **Can I compare Dev with production directly?** Only with explicit awareness of differences in resources, data, traffic, and generator location; they are different test conditions.
6. **Do a few smoke-test requests establish a baseline?** No; they help verify configuration, but do not establish stable performance under realistic load.


**1. Do you need a baseline for every API?**

No—you don’t need to start with every endpoint. I would prioritize:

- **Frequently used APIs:** login, product listing, search.
- **Business-critical APIs:** checkout, payment, order creation.
- **Expensive or historically slow APIs:** reports, large database queries.
- **Recently changed APIs:** where you need to detect performance regressions.

Test realistic user flows too—for example, login → search → add to cart → checkout. Separate endpoint tests help diagnose problems; mixed flows show how APIs behave while sharing resources.

**Keep results per endpoint**, even when testing several together. An overall p95 can hide a slow endpoint that receives relatively few requests. You don’t need a separate script for each API; k6 supports thresholds on tagged requests. [k6 thresholds documentation](https://grafana.com/docs/k6/latest/using-k6/thresholds/)

**2. Where do threshold values come from?**

**k6 doesn’t choose these values—you define what performance is acceptable.** The `400 ms` and `1%` in your notes are examples, not standard values for all applications.

Use these sources:

| Source | What to look for |
|---|---|
| Performance requirements or SLA | Documented response-time and reliability commitments |
| Team’s SLOs—service-level objectives | Targets agreed with product, backend, and operations teams |
| Production monitoring | Current latency, failure rates, and normal traffic levels |
| Repeated baseline tests | Stable measurements to help propose limits when requirements are missing |

Thresholds translate those expectations into test pass/fail rules. [k6 thresholds documentation](https://grafana.com/docs/k6/latest/using-k6/thresholds/)

For example, suppose repeated healthy tests show **p95 around 300 ms**:

- The agreed requirement is **p95 below 500 ms**.
- You could enforce `p(95)<500` to check that requirement.
- You might also choose a tighter **390 ms regression limit**, using 30% headroom, if normal variation supports it.

But if the requirement is **below 250 ms**, your 300 ms baseline already misses the target. Raising the threshold wouldn’t solve the performance issue.

For the values in your script:

```javascript
thresholds: {
  http_req_duration: ['p(95)<400'], // Chosen latency limit: 400 ms
  http_req_failed: ['rate<0.01'],   // Chosen failure allowance: below 1%
  checks: ['rate==1'],             // Require every check to pass
}
```

Choose the error allowance separately from latency. Observing failures in a baseline does not automatically make them acceptable.

For your practice, run with thresholds disabled first, repeat under the same conditions, and record results. Then propose limits and confirm them with your team. **A baseline answers “How does it perform?” A threshold answers “Is that acceptable?”**