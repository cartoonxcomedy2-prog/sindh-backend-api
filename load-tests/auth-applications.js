import http from 'k6/http';
import { check, sleep } from 'k6';

const API_BASE = (__ENV.BASE_URL || 'http://localhost:5000/api').replace(
    /\/+$/,
    ''
);
const EMAIL = __ENV.LOGIN_EMAIL || '';
const PASSWORD = __ENV.LOGIN_PASSWORD || '';
const MODE = String(__ENV.MODE || 'user').toLowerCase();

export const options = {
    vus: Number(__ENV.VUS || 5),
    duration: __ENV.DURATION || '1m',
    thresholds: {
        http_req_duration: ['p(95)<1200'],
        http_req_failed: ['rate<0.03'],
    },
};

const authHeaders = {
    headers: {
        'Content-Type': 'application/json',
    },
};

export default function () {
    if (!EMAIL || !PASSWORD) {
        throw new Error(
            'Missing LOGIN_EMAIL or LOGIN_PASSWORD environment variables.'
        );
    }

    const loginRes = http.post(
        `${API_BASE}/users/login`,
        JSON.stringify({
            email: EMAIL,
            password: PASSWORD,
        }),
        authHeaders
    );

    check(loginRes, {
        'login status < 400': (r) => r.status < 400,
        'login includes token': (r) => {
            try {
                return Boolean(JSON.parse(r.body || '{}').token);
            } catch (_) {
                return false;
            }
        },
    });

    if (loginRes.status >= 400) {
        sleep(1);
        return;
    }

    let token = '';
    try {
        token = JSON.parse(loginRes.body || '{}').token || '';
    } catch (_) {
        token = '';
    }

    if (!token) {
        sleep(1);
        return;
    }

    const protectedHeaders = {
        headers: {
            Authorization: `Bearer ${token}`,
        },
    };

    const profileRes = http.get(`${API_BASE}/users/profile`, protectedHeaders);
    check(profileRes, {
        'profile returns 200': (r) => r.status === 200,
    });

    const applicationsPath =
        MODE === 'admin' ? '/applications/admin/list' : '/applications/me';

    const applicationsRes = http.get(
        `${API_BASE}${applicationsPath}?page=1&limit=20`,
        protectedHeaders
    );
    check(applicationsRes, {
        'applications endpoint returns < 500': (r) => r.status < 500,
    });

    sleep(1);
}
