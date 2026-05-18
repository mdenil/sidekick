// Probe the sidekick proxy's HTTPAgentUpstream class against whichever
// backend UPSTREAM_URL points at. Run from sidekick repo root.
// Usage:
//   UPSTREAM_URL=http://127.0.0.1:8645 node scripts/dev-tests/upstream-probe.mjs  # hermes
//   UPSTREAM_URL=http://127.0.0.1:8646 node scripts/dev-tests/upstream-probe.mjs  # openclaw
import { HTTPAgentUpstream } from '../../proxy/sidekick/upstream.ts';
const url = process.env.UPSTREAM_URL || 'http://127.0.0.1:8645';
const upstream = new HTTPAgentUpstream({ url });
const result = await upstream.healthcheck();
console.log(`proxy.healthcheck(${url}) →`, JSON.stringify(result));
