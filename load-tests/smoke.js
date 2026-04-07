import http from 'k6/http';
import { check, sleep } from 'k6';

const API_BASE = (__ENV.BASE_URL || 'http://localhost:5000/api').replace(
    /\/+$/,
    ''
);
const ORIGIN = API_BASE.endsWith('/api')
    ? API_BASE.slice(0, -4)
    : API_BASE;

export const options = {
    vus: Number(__ENV.VUS || 10),
    duration: __ENV.DURATION || '1m',
    thresholds: {
        http_req_duration: ['p(95)<800'],
        http_req_failed: ['rate<0.02'],
    },
};

export default function () {
    const rootRes = http.get(`${ORIGIN}/`);
    check(rootRes, {
        'root endpoint is reachable': (r) => r.status >= 200 && r.status < 500,
    });

    const bannersRes = http.get(`${API_BASE}/banners`);
    check(bannersRes, {
        'banners returns 200': (r) => r.status === 200,
    });

    const universitiesRes = http.get(`${API_BASE}/universities`);
    check(universitiesRes, {
        'universities returns 200': (r) => r.status === 200,
    });

    const scholarshipsRes = http.get(`${API_BASE}/scholarships`);
    check(scholarshipsRes, {
        'scholarships returns 200': (r) => r.status === 200,
    });

    sleep(1);
}
