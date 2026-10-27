(function (root) {
  'use strict';
  function groupByProvider(accounts) {
    const groups = new Map();
    for (const a of accounts || []) {
      const provider = a.provider === 'opencode2' ? 'opencode' : a.provider;
      let g = groups.get(provider);
      if (!g) {
        g = { id: `provider-${provider}`, provider, providerGroup: true, members: [], models: [], daily: [],
          today: { cost: 0, tokens: 0 }, last7d: { cost: 0, tokens: 0 }, month: { cost: 0, tokens: 0 }, allTime: { cost: 0, tokens: 0 },
          cache: null, usageError: '', _models: new Map(), _days: new Map() };
        groups.set(provider, g);
      }
      g.members.push(a);
      g.dailyUnavailable ||= !!a.dailyUnavailable;
      for (const period of ['today', 'last7d', 'month', 'allTime']) {
        g[period].cost += Number(a[period]?.cost) || 0;
        g[period].tokens += Number(a[period]?.tokens) || 0;
      }
      for (const row of a.daily || []) {
        const day = g._days.get(row.date) || { date: row.date, cost: 0, tokens: 0, unpriced: false };
        day.cost += Number(row.cost) || 0; day.tokens += Number(row.tokens) || 0; day.unpriced ||= row.unpriced;
        g._days.set(row.date, day);
      }
      for (const m of a.models || []) {
        const model = g._models.get(m.modelName) || { modelName: m.modelName, provider: m.provider, tokens: {}, cost: {}, unpriced: false };
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) model.tokens[key] = (model.tokens[key] || 0) + (Number(m.tokens?.[key]) || 0);
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) model.cost[key] = (model.cost[key] || 0) + (Number(m.cost?.[key]) || 0);
        model.unpriced ||= m.unpriced;
        model.totalCostOnly ||= m.totalCostOnly;
        g._models.set(m.modelName, model);
      }
      if (a.cache) {
        g.cache ||= { models: [], unpriced: false };
        for (const key of ['freshInput', 'cacheRead', 'cacheWrite', 'output', 'savedUsd', 'writePremiumUsd', 'netSavedUsd', 'wouldHaveCostUsd']) {
          g.cache[key] = (g.cache[key] || 0) + (Number(a.cache[key]) || 0);
        }
        g.cache.unpriced ||= a.cache.unpriced;
      }
    }
    const order = ['codex', 'claude', 'antigravity', 'opencode', 'grok', 'devin'];
    return [...groups.values()].map(g => {
      g.models = [...g._models.values()].sort((a, b) => b.cost.total - a.cost.total);
      g.daily = [...g._days.values()].sort((a, b) => a.date.localeCompare(b.date));
      if (g.cache) {
        const input = g.cache.freshInput + g.cache.cacheRead;
        g.cache.hitRate = input ? g.cache.cacheRead / input : 0;
      }
      g.usageError = [...new Set(g.members.map(a => a.usageError).filter(Boolean))].join('; ');
      const stale = g.members.filter(a => a.stale);
      g.cachedNote = stale.length ? `Includes usage last observed ${new Date(Math.min(...stale.map(a => Date.parse(a.fetchedAt)).filter(Number.isFinite))).toLocaleString()}` : '';
      delete g._models; delete g._days;
      return g;
    }).sort((a, b) => (order.indexOf(a.provider) < 0 ? 99 : order.indexOf(a.provider)) - (order.indexOf(b.provider) < 0 ? 99 : order.indexOf(b.provider)));
  }
  if (typeof module === 'object' && module.exports) module.exports = { groupByProvider };
  else root.groupByProvider = groupByProvider;
})(typeof globalThis !== 'undefined' ? globalThis : this);
