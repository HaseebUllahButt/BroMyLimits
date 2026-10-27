// The optional adapter runs out of process so a missing/incompatible Helm or
// an unreachable hub cannot hold the local dashboard open indefinitely.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [source, machine] = process.argv.slice(2);
const load = relative => import(pathToFileURL(join(source, relative)).href);
try {
  const { loadNetwork } = await load('packages/protocol/network.js');
  const { hubRpc } = await load('packages/connect/src/hub-client.js');
  const { foldBuckets, splitKey } = await load('packages/usage/src/index.js');
  const { priceBucket, providerOf } = await load('packages/usage/src/pricing.js');
  const net = loadNetwork();
  if (!net?.machines?.[machine] || net.revoked?.[machine]) throw new Error('Machine is not a Helm member');
  const rpc = (method, params = {}) => hubRpc(net, machine, method, params, { timeout: 7000 });
  const report = await rpc('usage.report', { by: ['engine', 'account', 'model'] });
  const summary = (daily, totals) => {
    const today = new Date().toISOString().slice(0, 10);
    const week = new Date(Date.parse(today) - 6 * 86400000).toISOString().slice(0, 10);
    const sum = rows => rows.reduce((s, r) => ({ cost: s.cost + r.costUsd, tokens: s.tokens + r.total }), { cost: 0, tokens: 0 });
    return { allTime: { cost: totals.costUsd, tokens: totals.total },
      today: sum(daily.filter(d => d.date === today)), last7d: sum(daily.filter(d => d.date >= week && d.date <= today)),
      month: sum(daily.filter(d => d.date.startsWith(today.slice(0, 7)) && d.date <= today)),
      daily: daily.map(d => ({ date: d.date, cost: d.costUsd, tokens: d.total, unpriced: d.unpriced })) };
  };
  const cache = t => ({ freshInput: t.input, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, output: t.output,
    hitRate: t.input + t.cacheRead ? t.cacheRead / (t.input + t.cacheRead) : 0,
    savedUsd: t.cacheSavedUsd, writePremiumUsd: t.cacheWritePremiumUsd,
    netSavedUsd: t.cacheSavedUsd - t.cacheWritePremiumUsd, unpriced: t.unpriced, models: [] });
  let accounts;
  if (report.stale) {
    // Offline hubs retain provider/model totals but no per-provider daily
    // series. Ask for calendar windows, and mark the missing chart detail.
    const today = new Date().toISOString().slice(0, 10);
    const since = [today, new Date(Date.parse(today) - 6 * 86400000).toISOString().slice(0, 10), `${today.slice(0, 7)}-01`];
    const windows = await Promise.all(since.map(day => rpc('usage.report', { since: day, until: today, by: ['engine', 'account', 'model'] })));
    const sumGroups = groups => {
      const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0, cacheSavedUsd: 0, cacheWritePremiumUsd: 0, unpriced: false };
      for (const g of groups) {
        for (const key of Object.keys(total)) if (key !== 'unpriced') total[key] += Number(g[key]) || 0;
        total.unpriced ||= g.unpriced;
      }
      return total;
    };
    accounts = [...new Set(report.groups.map(g => g.account))].map(account => {
      const models = report.groups.filter(g => g.account === account);
      const engine = models[0].engine;
      const totals = sumGroups(models);
      const periods = windows.map(w => sumGroups(w.groups.filter(g => g.account === account)));
      return { id: account, provider: engine === 'opencode2' ? 'opencode' : engine,
        label: report.accounts?.find(a => a.account === account)?.profileId || account.split(/[\\/]/).pop() || engine,
        allTime: { cost: totals.costUsd, tokens: totals.total },
        ...Object.fromEntries(['today', 'last7d', 'month'].map((name, i) => [name, { cost: periods[i].costUsd, tokens: periods[i].total }])),
        dailyUnavailable: true, summaryDate: today, cache: cache(totals), rateLimits: null,
        usageSources: ['Helm cached report'],
        models: models.map(g => ({ modelName: g.model, provider: providerOf(g.model), unpriced: g.unpriced,
          tokens: { input: g.input, output: g.output, cacheRead: g.cacheRead, cacheWrite: g.cacheWrite },
          cost: { total: g.costUsd }, totalCostOnly: true })) };
    });
  } else {
    const rollup = await rpc('usage.buckets');
    const groups = new Map();
    for (const [key, bucket] of Object.entries(rollup.buckets)) {
      const group = groups.get(bucket.account) || {};
      group[key] = bucket;
      groups.set(bucket.account, group);
    }
    accounts = [...groups].map(([account, buckets]) => {
      const folded = foldBuckets(buckets, { by: ['model'] });
      const engine = Object.values(buckets)[0].engine;
      const models = new Map();
      for (const [key, b] of Object.entries(buckets)) {
        const { date, model } = splitKey(key.slice(key.indexOf('\0') + 1));
        const m = models.get(model) || { modelName: model, provider: providerOf(model), unpriced: false,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        const billed = b.billedUsd > 0;
        const cost = billed ? { total: b.billedUsd } : priceBucket(engine, model, b, date);
        for (const channel of Object.keys(m.tokens)) m.tokens[channel] += b[channel] || 0;
        for (const channel of Object.keys(m.cost)) m.cost[channel] += cost?.[channel] || 0;
        m.unpriced ||= !cost;
        m.totalCostOnly ||= billed;
        models.set(model, m);
      }
      const profile = rollup.accounts?.find(a => a.account === account);
      return { id: account, provider: engine === 'opencode2' ? 'opencode' : engine,
        label: profile?.profileId || account.split(/[\\/]/).pop() || engine,
        ...summary(folded.daily, folded.totals), models: [...models.values()], cache: cache(folded.totals),
        rateLimits: null, usageSources: ['Helm usage rollup'] };
    });
    report.at = rollup.at;
  }
  process.stdout.write(JSON.stringify({ accounts, fetchedAt: new Date(report.at).toISOString(), stale: !!report.stale }));
} catch (error) {
  process.stderr.write(`Helm usage unavailable: ${error.message}\n`);
  process.exitCode = 1;
}
