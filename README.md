# K6 protocol/API capacity test

This starter test is for the downsized **Dev** VM discussed in the shared chat. It sends read-only HTTP API requests, begins with a one-user smoke test, and provides an explicitly enabled 20-VU scenario for each configured role. With the nine roles in `.env`, the load profile reaches 180 total VUs.

It does not open browser tabs or render the UI. That keeps the measurement focused on the API/backend and the 2-CPU VM.

## 1. Choose representative APIs

For Luminar Dev, the public frontend configuration currently points to:

```text
https://dev.luminar.sazimlabs.com/api/v1
```

Public frontend inspection identified `GET /work-orders/list` for the Purchase
Order/Work Order table and `GET /styles/{styleId}/boms/{bomId}` for a BOM
detail. The latter needs IDs from existing Dev test data. Capture the actual
Style-list request and one representative BOM request in the signed-in browser
before running the test; do not guess IDs or load-test a login endpoint.

Sign in to Dev in your browser, open **Developer Tools → Network → Fetch/XHR**, and perform the Style, PO, and BOM workflows. Start with three safe GET endpoints, such as list or detail requests.

Record only:

- the Dev base URL;
- each request path, including any required query string;
- whether authentication uses a bearer token, session cookie, or additional headers;
- the normal success status code.

Use a dedicated test account. Do not commit tokens, cookies, passwords, or copied request headers.

Do not place secrets in `BASE_URL` or `API_PATHS`. Percent-encode commas in query values as `%2C`, because commas separate entries in `API_PATHS`.

## 2. Validate without sending traffic

This checks the JavaScript and resolved K6 options. `inspect` does not execute the preflight or test requests:

```bash
k6 inspect --execution-requirements \
  -e BASE_URL='https://example.invalid' \
  -e API_PATHS='/api/example' \
  tests/api-load.js
```

## 3. Run the smoke test

The script requires a target and one or more comma-separated API paths:

```bash
k6 run \
  -e BASE_URL='https://dev.luminar.sazimlabs.com/api/v1' \
  -e API_PATHS='/replace-with-style-request,/work-orders/list?page=1&limit=20,/styles/STYLE_ID/boms/BOM_ID' \
  tests/api-load.js
```

The default uses one virtual user and makes one test request per endpoint. Before that, a preflight verifies every endpoint's status and JSON content type. It expects HTTP `200`, less than 1% failed requests, and p95 response time below 1000 ms.

The smoke p95 is only a connectivity/configuration check because the sample is tiny; it is not a performance baseline. The final summary reports latency and failures separately as `endpoint_1`, `endpoint_2`, and so on. The startup log maps each label to its query-stripped route.

The test authenticates once during setup using a role from `.env` (default `EXECUTIVE`), then shares the returned token across VUs. Select another configured role with `-e LOGIN_ROLE=MERCHANDISER`; supported role names match the `.env` prefixes, which use shell-safe names such as `EXECUTIVE_EMAIL` and `EXECUTIVE_PASSWORD`. The login endpoint defaults to `/auth/sign-in/email` and can be changed with `LOGIN_PATH`.

For an existing bearer token, enter it without putting it directly in the command:

```bash
read -s AUTH_TOKEN
export AUTH_TOKEN

k6 run \
  -e BASE_URL='https://dev.example.com' \
  -e API_PATHS='/api/styles,/api/purchase-orders,/api/boms' \
  tests/api-load.js

unset AUTH_TOKEN
```

If the application uses a session cookie instead, set `SESSION_COOKIE` the same way. Extra headers such as a tenant or CSRF header can be supplied as a JSON object through `HEADERS_JSON`.

Authenticated requests require HTTPS. If an internal Dev environment genuinely uses plain HTTP, explicitly pass `-e ALLOW_INSECURE_AUTH=true`, understanding that credentials will not be protected in transit.

## 4. Run the controlled load profile

Only proceed after the smoke test passes and the backend/DevOps engineer is ready to monitor the Dev VM:

```bash
k6 run \
  -e PROFILE=load \
  -e CONFIRM_BASE_URL='https://dev.luminar.sazimlabs.com/api/v1' \
  -e BASE_URL='https://dev.luminar.sazimlabs.com/api/v1' \
  -e API_PATHS='/replace-with-style-request,/work-orders/list?page=1&limit=20,/styles/STYLE_ID/boms/BOM_ID' \
  tests/api-load.js
```

Each role scenario ramps to and briefly holds at 5, 10, and 20 virtual users, then ramps down. All role scenarios run concurrently and take about 4 minutes. Stop it with `Ctrl+C` if latency, failures, or infrastructure health becomes unacceptable.

Do not add K6 execution flags such as `--vus`, `--duration`, `--iterations`, `--stage`, `--no-setup`, or `--no-thresholds`. They can replace or disable safety controls; scenario, preflight, and redirect overrides are detected and aborted before a request.

Each VU independently rotates across the configured GET endpoints with a one-second pause. This is an equal-mix backend capacity test, not a correlated Style → PO → BOM business journey and not a fixed requests-per-second test. All VUs share the supplied token or cookie; make sure it remains valid for the full run and confirm that one shared account is representative for this first test.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `BASE_URL` | required | Authorized Dev target, without a trailing slash |
| `API_PATHS` | required | Comma-separated read-only API paths |
| `PROFILE` | `smoke` | `smoke` or `load` |
| `LOGIN_ROLE` | `EXECUTIVE` | Role prefix used for a smoke run; load runs all roles listed in `ROLES` |
| `ROLES` | all 9 `.env` roles | Comma-separated role prefixes |
| `VUS_PER_ROLE` | `20` | Maximum VUs assigned to each role scenario |
| `LOAD_HOLD_DURATION` | `1m` | Hold time at each load target; use `2m40s` with 100 VUs for a 10-minute run |
| `LOGIN_PATH` | `/auth/sign-in/email` | Relative API login path |
| `CONFIRM_BASE_URL` | unset | Must exactly match `BASE_URL` for the load profile |
| `AUTH_TOKEN` | unset | Token sent in the authentication header |
| `AUTH_HEADER` | `Authorization` | Authentication header name |
| `AUTH_SCHEME` | `Bearer` | Token scheme; set to an empty value for a raw token |
| `SESSION_COOKIE` | unset | Full Cookie header value for session authentication |
| `HEADERS_JSON` | unset | Additional string-valued request headers as JSON |
| `WEB_BASE_URL` | API host | Host for Next.js data requests |
| `WEB_PATHS` | dashboard and create-style data paths | Comma-separated frontend prefetch paths |
| `ALLOW_INSECURE_AUTH` | `false` | Explicitly permit credentials over plain HTTP |
| `EXPECTED_STATUSES` | `200` | Comma-separated acceptable status codes |
| `EXPECTED_CONTENT_TYPE` | `application/json` | Required preflight Content-Type substring; set empty to disable |
| `P95_MS` | `1000` | Maximum acceptable p95 request duration in milliseconds |
| `MAX_FAILED_RATE` | `0.01` | Threshold for failed requests and checks |
| `HTTP_TIMEOUT` | `10s` | Per-request timeout |
| `THINK_TIME_SECONDS` | `1` | Pause between requests from each virtual user; minimum `0.5` |

The emergency limits are fixed: the test aborts when the cumulative failed-request rate reaches 10% after the first 15 seconds, or when cumulative p95 exceeds 5000 ms after the first 30 seconds.

## Interpret the result

The terminal summary is aggregate for the whole ramp; its `endpoint_N` rows are per-endpoint aggregates, not per-stage results. Correlate the live K6 timeline with GCP CPU, memory, backend latency, 5xx responses, and database connections/latency. Requests include an `active_vus` tag for a time-series output. Use that output or separate plateau tests later if you need exact p95/p99 numbers for each VU level.

This starter deliberately performs GET requests and validates status plus preflight content type only. Add application-specific JSON checks once the response contracts are known. Creating Styles, POs, or BOMs needs application-specific payloads, unique test data, and a cleanup strategy; add those flows only after the exact API requests are known.
