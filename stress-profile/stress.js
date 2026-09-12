import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 }, // ramp from 0 VU to 20 VU
    { duration: '1m', target: 20 },  // sustain 20 VU
    { duration: '30s', target: 40 }, // ramp from 20 VU to 40 VU
    { duration: '1m', target: 40 },  // sustain 40 VU
    { duration: '30s', target: 60 }, // ramp from 40 VU to 60 VU
    { duration: '1m', target: 60 },  // sustain 60 VU
    { duration: '30s', target: 0 },  // ramp from 60 VU to 0 VU
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.05'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const res = http.get('https://quickpizza.grafana.com');

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response body is not empty': (r) => r.body.length > 0,
  });

  sleep(1);
}




