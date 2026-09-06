// import http from 'k6/http';
// import { check, sleep } from 'k6';

// export const opotions = {
//     iterations: 10,
// }

// export default function () {
//     const res = http.get('https://quickpizza.grafana.com');
//     check(res, {
//         'status is 200': (r) => r.status === 200,
//     })
//     sleep(1);
// }

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 20 },
        { duration: '30s', target: 0 },
    ],
};

export default function () {
    const res = http.get('https://quickpizza.grafana.com');

    check(res, {
        'status is 200': (r) => r.status === 200,
        'response body is not empty': (r) => r.body.length > 0,
    });

    sleep(1);
}