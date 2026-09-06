import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

function required(name) {
  const value = (__ENV[name] || '').trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function numberFromEnv(name, defaultValue, minimum) {
  const rawValue = (__ENV[name] || '').trim();
  const value = rawValue ? Number(rawValue) : defaultValue;

  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a number greater than or equal to ${minimum}`);
  }

  return value;
}

function integerList(name, defaultValue) {
  const values = (__ENV[name] || defaultValue)
    .split(',')
    .map((value) => Number(value.trim()));

  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error(`${name} must be a comma-separated list of positive integers`);
  }

  return [...new Set(values)];
}

function pathsFromEnv(name, defaultValue = '') {
  const rawPaths = (__ENV[name] || defaultValue).trim();
  const paths = rawPaths
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);

  if (paths.length === 0 || paths.some((path) => !path.startsWith('/') || path.startsWith('//'))) {
    throw new Error(`Every ${name} entry must be a relative path beginning with one /`);
  }

  return [...new Set(paths)];
}

function headersFromEnv() {
  const rawHeaders = (__ENV.HEADERS_JSON || '').trim();

  if (!rawHeaders) {
    return {};
  }

  let headers;

  try {
    headers = JSON.parse(rawHeaders);
  } catch (_error) {
    throw new Error('HEADERS_JSON must be valid JSON');
  }

  if (!headers || Array.isArray(headers) || typeof headers !== 'object') {
    throw new Error('HEADERS_JSON must be a JSON object');
  }

  const reservedHeaders = new Set(['connection', 'content-length', 'host', 'transfer-encoding']);

  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      throw new Error(`HEADERS_JSON value for ${name} must be a string`);
    }

    if (reservedHeaders.has(name.toLowerCase())) {
      throw new Error(`HEADERS_JSON cannot override the ${name} header`);
    }
  }

  return headers;
}

const BASE_URL = required('BASE_URL').replace(/\/+$/, '');
const API_PATHS = pathsFromEnv('API_PATHS');
const WEB_BASE_URL = (__ENV.WEB_BASE_URL || BASE_URL.replace(/\/api\/v1$/i, '')).replace(/\/+$/, '');
const WEB_PATHS = pathsFromEnv(
  'WEB_PATHS',
  '/_next/data/1788290443201/en-US/dashboard.json,/_next/data/1788290443201/en-US/dashboard/styles/create.json',
);
const ENDPOINTS = [
  ...API_PATHS.map((path, index) => ({
    baseUrl: BASE_URL,
    path,
    name: path.split('?')[0],
    tag: `endpoint_${index + 1}`,
  })),
  ...WEB_PATHS.map((path, index) => ({
    baseUrl: WEB_BASE_URL,
    path,
    name: path.split('?')[0],
    tag: `endpoint_${API_PATHS.length + index + 1}`,
  })),
];
const LOGIN_ROLES = (__ENV.ROLES || 'EXECUTIVE,TECH_ADMIN,MERCHANDISER,INVENTORY,KNITTING,INDUSTRIAL_ENGINEERING,YARN_PROCUREMENT,PRODUCTION,PLANNING')
  .split(',')
  .map((role) => role.trim().toUpperCase())
  .filter(Boolean);
const ROLE_SCENARIO_NAMES = LOGIN_ROLES.map((role) => `role_${role.toLowerCase()}`);
const scenarioNameForRole = (role) => `role_${role.toLowerCase()}`;
const VUS_PER_ROLE = numberFromEnv('VUS_PER_ROLE', 20, 1);
const LOAD_HOLD_DURATION = __ENV.LOAD_HOLD_DURATION || '1m';
const loadTargets = [Math.ceil(VUS_PER_ROLE / 4), Math.ceil(VUS_PER_ROLE / 2), VUS_PER_ROLE];
const LOAD_TARGETS = loadTargets;
const ABSOLUTE_MAX_VUS = LOGIN_ROLES.length * VUS_PER_ROLE;

const PROFILE = (__ENV.PROFILE || 'smoke').trim().toLowerCase();
const EXPECTED_STATUSES = integerList('EXPECTED_STATUSES', '200');
const EXPECTED_CONTENT_TYPE =
  typeof __ENV.EXPECTED_CONTENT_TYPE === 'string'
    ? __ENV.EXPECTED_CONTENT_TYPE.trim().toLowerCase()
    : 'application/json';
const THINK_TIME_SECONDS = numberFromEnv('THINK_TIME_SECONDS', 1, 0.5);
const P95_MS = numberFromEnv('P95_MS', 1000, 1);
const MAX_FAILED_RATE = numberFromEnv('MAX_FAILED_RATE', 0.01, 0);
const HTTP_TIMEOUT = __ENV.HTTP_TIMEOUT || '10s';
const LOGIN_PATH = __ENV.LOGIN_PATH || '/auth/sign-in/email';
const LOGIN_ROLE = (__ENV.LOGIN_ROLE || 'EXECUTIVE').trim().toUpperCase();
const ABORT_P95_MS = 5000;
const ABORT_FAILED_RATE = 0.1;

if (!/^https?:\/\/[^\s]+$/i.test(BASE_URL)) {
  throw new Error('BASE_URL must be an absolute http:// or https:// URL');
}

if (/[?#]/.test(BASE_URL)) {
  throw new Error('Put query strings in API_PATHS, not BASE_URL');
}

const baseAuthority = BASE_URL.replace(/^https?:\/\//i, '').split('/')[0];

if (!baseAuthority || baseAuthority.includes('@')) {
  throw new Error('BASE_URL must contain a host and must not contain embedded credentials');
}

if (!['smoke', 'load'].includes(PROFILE)) {
  throw new Error('PROFILE must be smoke or load');
}

if (MAX_FAILED_RATE >= 1 || ABORT_FAILED_RATE >= 1) {
  throw new Error('MAX_FAILED_RATE and ABORT_FAILED_RATE must be less than 1');
}

if (ABORT_FAILED_RATE <= MAX_FAILED_RATE) {
  throw new Error('ABORT_FAILED_RATE must be greater than MAX_FAILED_RATE');
}

if (ABORT_P95_MS <= P95_MS) {
  throw new Error('ABORT_P95_MS must be greater than P95_MS');
}

if (EXPECTED_STATUSES.some((status) => status < 100 || status > 599)) {
  throw new Error('EXPECTED_STATUSES values must be valid HTTP status codes');
}

const confirmedBaseUrl = (__ENV.CONFIRM_BASE_URL || '').trim().replace(/\/+$/, '');

if (PROFILE === 'load' && confirmedBaseUrl !== BASE_URL) {
  throw new Error('CONFIRM_BASE_URL must exactly match BASE_URL to run the load profile');
}

const additionalHeaders = headersFromEnv();
const requestHeaders = {
  Accept: 'application/json',
  ...additionalHeaders,
};

const authToken = (__ENV.AUTH_TOKEN || '').trim();
const sessionCookie = (__ENV.SESSION_COOKIE || '').trim();

function loginHeaders(role) {
  const email = (__ENV[`${role}_EMAIL`] || '').trim();
  const password = (__ENV[`${role}_PASSWORD`] || '').trim();

  if (!email || !password) {
    throw new Error(`Missing ${role}_EMAIL or ${role}_PASSWORD`);
  }

  const loginJar = http.cookieJar();
  loginJar.clear(BASE_URL);
  loginJar.delete(BASE_URL, '__Secure-better-auth.session_token');
  const response = http.post(`${BASE_URL}${LOGIN_PATH}`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    jar: loginJar,
    responseType: 'text',
    timeout: HTTP_TIMEOUT,
    tags: { phase: 'authentication' },
  });

  if (response.status !== 200) {
    throw new Error(`Authentication failed for ${role}: HTTP ${response.status}`);
  }

  const body = response.json();

  if (body && typeof body.token === 'string' && body.token) {
    return { ...requestHeaders, Authorization: `Bearer ${body.token}` };
  }

  const cookies = response.cookies['__Secure-better-auth.session_token'] || [];
  if (cookies.length > 0 && cookies[0].value) {
    return { ...requestHeaders, Cookie: `__Secure-better-auth.session_token=${cookies[0].value}` };
  }

  throw new Error(`Authentication response for ${role} contained no token or session cookie`);
}

if (authToken) {
  const authHeader = (__ENV.AUTH_HEADER || 'Authorization').trim();
  const authScheme = typeof __ENV.AUTH_SCHEME === 'string' ? __ENV.AUTH_SCHEME.trim() : 'Bearer';

  if (!/^[A-Za-z0-9-]+$/.test(authHeader)) {
    throw new Error('AUTH_HEADER must be a non-empty HTTP header name containing letters, digits, or hyphens');
  }

  if (Object.keys(requestHeaders).some((name) => name.toLowerCase() === authHeader.toLowerCase())) {
    throw new Error(`Do not set ${authHeader} in both AUTH_TOKEN and HEADERS_JSON`);
  }

  requestHeaders[authHeader] = authScheme ? `${authScheme} ${authToken}` : authToken;
}

if (sessionCookie) {
  if (Object.keys(requestHeaders).some((name) => name.toLowerCase() === 'cookie')) {
    throw new Error('Do not set Cookie in both SESSION_COOKIE and HEADERS_JSON');
  }

  requestHeaders.Cookie = sessionCookie;
}

const hasCredentials = Boolean(
  authToken || sessionCookie || Object.keys(additionalHeaders).length > 0,
);

if (
  BASE_URL.toLowerCase().startsWith('http://') &&
  hasCredentials &&
  (__ENV.ALLOW_INSECURE_AUTH || '').toLowerCase() !== 'true'
) {
  throw new Error('Authenticated HTTP is blocked; use HTTPS or explicitly set ALLOW_INSECURE_AUTH=true');
}

const smokeScenario = {
  executor: 'shared-iterations',
  vus: 1,
  iterations: ENDPOINTS.length,
  maxDuration: '1m',
  gracefulStop: '5s',
};

function loadScenario() {
  const stages = [];

  for (const target of LOAD_TARGETS) {
    stages.push({ duration: '30s', target });
    stages.push({ duration: LOAD_HOLD_DURATION, target });
  }

  stages.push({ duration: '30s', target: 0 });

  return {
    executor: 'ramping-vus',
    startVUs: 0,
    stages,
    gracefulRampDown: '10s',
  };
}

const loadScenarios = Object.fromEntries(
  ROLE_SCENARIO_NAMES.map((scenarioName) => [scenarioName, loadScenario()]),
);

const failedRateThreshold = MAX_FAILED_RATE === 0 ? 'rate==0' : `rate<${MAX_FAILED_RATE}`;

const thresholds = {
  'http_req_failed{phase:test}': [
    failedRateThreshold,
    {
      threshold: `rate<${ABORT_FAILED_RATE}`,
      abortOnFail: true,
      delayAbortEval: '15s',
    },
  ],
  'http_req_duration{phase:test}': [
    `p(95)<${P95_MS}`,
    {
      threshold: `p(95)<${ABORT_P95_MS}`,
      abortOnFail: true,
      delayAbortEval: '30s',
    },
  ],
  checks: [MAX_FAILED_RATE === 0 ? 'rate==1' : `rate>${1 - MAX_FAILED_RATE}`],
};

for (const endpoint of ENDPOINTS) {
  thresholds[`http_req_failed{phase:test,endpoint:${endpoint.tag}}`] = [failedRateThreshold];
  thresholds[`http_req_duration{phase:test,endpoint:${endpoint.tag}}`] = [`p(95)<${P95_MS}`];
}

export const options = {
  scenarios: {
    ...(PROFILE === 'load' ? loadScenarios : { api: smokeScenario }),
  },
  thresholds,
  discardResponseBodies: true,
  maxRedirects: 0,
  systemTags: [
    'check',
    'error',
    'error_code',
    'expected_response',
    'group',
    'method',
    'name',
    'proto',
    'scenario',
    'status',
    'tls_version',
  ],
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  tags: {
    profile: PROFILE,
    test_type: 'protocol-api',
  },
  userAgent: 'k6-dev-capacity-test/1.0',
};

const expectedResponse = http.expectedStatuses(...EXPECTED_STATUSES);
const expectedStatusSet = new Set(EXPECTED_STATUSES);

function assertSafeExecutionPlan() {
  const scenarios = exec.test.options.scenarios || {};
  const scenarioNames = Object.keys(scenarios);

  if (exec.test.options.noSetup) {
    exec.test.abort('The preflight cannot be disabled with --no-setup');
    return;
  }

  if (exec.test.options.maxRedirects !== 0) {
    exec.test.abort('Redirect handling was overridden; refusing to send traffic');
    return;
  }

  if (
    (PROFILE === 'smoke' && (scenarioNames.length !== 1 || scenarioNames[0] !== 'api')) ||
    (PROFILE === 'load' &&
      (scenarioNames.length !== ROLE_SCENARIO_NAMES.length ||
        scenarioNames.some((name) => !ROLE_SCENARIO_NAMES.includes(name))))
  ) {
    exec.test.abort('Execution flags replaced the guarded api scenario; run the documented command without VU, duration, iteration, or stage overrides');
    return;
  }

  const scenario = scenarios.api;

  if (PROFILE === 'smoke' && (scenario.executor !== 'shared-iterations' || scenario.vus > 1)) {
    exec.test.abort('The smoke execution plan was overridden; refusing to send traffic');
    return;
  }

  if (PROFILE === 'load') {
    for (const scenarioName of scenarioNames) {
      const roleScenario = scenarios[scenarioName];
      const targets = (roleScenario.stages || []).map((stage) => stage.target);

      if (
        roleScenario.executor !== 'ramping-vus' ||
        roleScenario.startVUs > VUS_PER_ROLE ||
        targets.length === 0 ||
        Math.max(...targets) > VUS_PER_ROLE
      ) {
        exec.test.abort(`Each role scenario must remain capped at ${VUS_PER_ROLE} VUs`);
      }
    }
  }
}

export function setup() {
  assertSafeExecutionPlan();
  const preflightRole = PROFILE === 'load' && LOGIN_ROLES.includes('MERCHANDISER')
    ? 'MERCHANDISER'
    : LOGIN_ROLE;
  const authenticatedHeaders = authToken || sessionCookie
    ? requestHeaders
    : loginHeaders(preflightRole);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Profile: ${PROFILE}`);
  console.log(`Login role: ${LOGIN_ROLE}`);
  console.log(`Read-only endpoints: ${ENDPOINTS.map((endpoint) => `${endpoint.tag}=${endpoint.name}`).join(', ')}`);

  for (const endpoint of ENDPOINTS) {
    const response = http.get(`${endpoint.baseUrl}${endpoint.path}`, {
      headers: authenticatedHeaders,
      responseCallback: expectedResponse,
      tags: {
        endpoint: endpoint.tag,
        name: `GET ${endpoint.name}`,
        phase: 'preflight',
      },
      timeout: HTTP_TIMEOUT,
    });

    if (!expectedStatusSet.has(response.status)) {
      throw new Error(
        `Preflight failed for GET ${endpoint.name}: expected ${EXPECTED_STATUSES.join(', ')}, got ${response.status}`,
      );
    }

    const contentType = String(response.headers['Content-Type'] || '').toLowerCase();

    if (EXPECTED_CONTENT_TYPE && !contentType.includes(EXPECTED_CONTENT_TYPE)) {
      throw new Error(
        `Preflight failed for GET ${endpoint.name}: expected Content-Type containing ${EXPECTED_CONTENT_TYPE}, got ${contentType || 'none'}`,
      );
    }
  }

  return { headers: authenticatedHeaders };
}

let vuHeaders;

export default function (data) {
  assertSafeExecutionPlan();
  const endpoint = ENDPOINTS[(__VU + __ITER - 1) % ENDPOINTS.length];
  const role = PROFILE === 'load'
    ? exec.scenario.name.replace(/^role_/, '').toUpperCase()
    : LOGIN_ROLE;

  if (!vuHeaders) {
    vuHeaders = authToken || sessionCookie ? requestHeaders : loginHeaders(role);
  }

  const response = http.get(`${endpoint.baseUrl}${endpoint.path}`, {
    headers: vuHeaders,
    responseCallback: expectedResponse,
    tags: {
      endpoint: endpoint.tag,
      name: `GET ${endpoint.name}`,
      phase: 'test',
      active_vus: String(exec.instance.vusActive),
    },
    timeout: HTTP_TIMEOUT,
  });

  check(
    response,
    {
      'status is expected': (result) => expectedStatusSet.has(result.status),
    },
    { endpoint: endpoint.tag },
  );

  sleep(THINK_TIME_SECONDS);
}
