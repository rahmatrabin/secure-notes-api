import http from 'k6/http';
import { check } from 'k6';

const { API_URL, ADMIN_TOKEN, USER_TOKEN, AUTHOR_IDS, LOAD_RPS, ALLOW_STAGING_LOAD } = __ENV;
if (ALLOW_STAGING_LOAD !== '1' || !API_URL || !ADMIN_TOKEN || !USER_TOKEN || !AUTHOR_IDS) {
  throw new Error('Set the staging API URL, test tokens, author IDs, and ALLOW_STAGING_LOAD=1');
}
if (/^https?:\/\/secure-notes-api-sdr9\.onrender\.com(?:[:/]|$)/i.test(API_URL)) {
  throw new Error('Use a staging service instead of the production service');
}
const authors = AUTHOR_IDS.split(',').map(id => id.trim());
if (authors.some(id => !/^[0-9a-f]{24}$/i.test(id))) throw new Error('Invalid author ID');
const rate = Number(LOAD_RPS ?? 100);
if (!Number.isInteger(rate) || rate < 1 || rate > 10_000) throw new Error('Invalid LOAD_RPS');
export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: '5m',
      preAllocatedVUs: 100, maxVUs: 500
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
    'http_req_duration{endpoint:interests}': ['p(95)<300'],
    checks: ['rate>0.99'],
    dropped_iterations: ['count==0']
  }
};

function read(path, token, endpoint) {
  const result = http.get(API_URL.replace(/\/$/, '') + path, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    tags: { endpoint }
  });
  check(result, { 'HTTP 200': response => response.status === 200 });
  return result;
}

export default function () {
  const pick = Math.random();
  if (pick < 0.6) {
    const author = authors[Math.floor(Math.random() * authors.length)];
    read('/users/' + author + '/posts', undefined, 'posts');
  } else if (pick < 0.95) {
    read('/notes', USER_TOKEN, 'notes');
  } else {
    const first = read('/admin/interest-groups', ADMIN_TOKEN, 'interests');
    if (first.status === 200 && first.json('nextCursor')) {
      read('/admin/interest-groups?cursor=' + encodeURIComponent(first.json('nextCursor')),
        ADMIN_TOKEN, 'interests');
    }
  }
}