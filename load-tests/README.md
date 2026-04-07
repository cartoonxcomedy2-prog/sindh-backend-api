# Backend Load Tests (k6)

## Prerequisites
- Install k6: https://k6.io/docs/get-started/installation/
- Ensure backend API is reachable.

## Smoke Test (Public Endpoints)
```bash
k6 run load-tests/smoke.js
```

Optional env:
```bash
BASE_URL=https://your-api.com/api VUS=20 DURATION=2m k6 run load-tests/smoke.js
```

## Auth + Applications Test
```bash
LOGIN_EMAIL=admin@sindh.com LOGIN_PASSWORD=secret MODE=admin k6 run load-tests/auth-applications.js
```

Optional env:
- `BASE_URL` default: `http://localhost:5000/api`
- `MODE` default: `user` (`admin` also supported)
- `VUS` default: `5`
- `DURATION` default: `1m`

## Suggested Baseline Targets
- `http_req_failed < 2-3%`
- `p95 latency < 800ms` for public endpoints
- `p95 latency < 1200ms` for auth/protected endpoints
