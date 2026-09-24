(() => {
  // packages/usage-view/index.ts
  var providerTitle = { anthropic: "Claude", codex: "Codex", grok: "Grok" };
  var windowShort = { five_hour: "5h", daily: "day", weekly: "wk", monthly: "mo", minute: "min" };
  var windowRank = { "5h": 0, day: 1, wk: 2, mo: 3 };
  var baseLabel = {
    "claude-max": "All models",
    "codex-pro": "All models",
    "codex-spark": "Spark",
    "codex-spark-weekly": "Spark weekly",
    "grok-super grok plus": "All usage"
  };
  var productLabel = {
    build: "Build",
    chat: "Chat",
    imagine: "Imagine",
    api: "API",
    prepaid: "Extra credits",
    reset: "Usage reset"
  };
  var FALLBACK_DOLLARS = 50;
  function ms(iso) {
    if (!iso)
      return null;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
  }
  function entitlementParts(entitlement) {
    const hash = entitlement.indexOf("#");
    const product = hash === -1 ? null : entitlement.slice(hash + 1);
    const body = hash === -1 ? entitlement : entitlement.slice(0, hash);
    const colon = body.indexOf(":");
    const account = colon === -1 ? null : body.slice(colon + 1) || null;
    return { base: colon === -1 ? body : body.slice(0, colon), account, product };
  }
  function rowLabel(o) {
    const { base, product } = entitlementParts(o.entitlement);
    if (product)
      return productLabel[product.toLowerCase()] ?? product.charAt(0).toUpperCase() + product.slice(1);
    if (o.metric === "reset_credit")
      return "Banked reset";
    return baseLabel[base.toLowerCase()] ?? base;
  }
  function fraction(o) {
    if (o.used == null || o.limit == null || o.limit <= 0)
      return null;
    return Math.min(Math.max(o.used / o.limit, 0), 1);
  }
  function planFromTier(tier) {
    const value = (tier ?? "").toLowerCase();
    if (!value)
      return null;
    if (value.includes("max_20") || value.includes("max 20"))
      return { name: "Max 20x", dollars: 200 };
    if (value.includes("max_5") || value.includes("max 5"))
      return { name: "Max 5x", dollars: 100 };
    if (value.includes("pro") || value === "default_claude_ai")
      return { name: "Pro", dollars: 20 };
    if (value.includes("max"))
      return { name: "Max", dollars: 100 };
    return null;
  }
  function toRow(o) {
    const id = `${o.provider}|${o.entitlement}|${o.window ?? ""}`;
    switch (o.metric) {
      case "allowance":
        return {
          kind: "allowance",
          id,
          label: rowLabel(o),
          window: o.window ? windowShort[o.window] ?? o.window : null,
          fractionUsed: fraction(o),
          resetsAt: ms(o.resetsAt),
          stale: o.stale === true,
          observedAt: ms(o.observedAt),
          segments: []
        };
      case "credit":
        return o.remaining == null ? null : {
          kind: "credit",
          id: `credit|${o.provider}|${o.entitlement}`,
          label: rowLabel(o),
          balance: o.remaining,
          unit: o.entitlement.includes("usd") || o.entitlement.includes("dollar") || o.entitlement.includes("prepaid") ? "USD" : "credits",
          resetsAt: ms(o.resetsAt)
        };
      case "reset_credit": {
        const expiresAt = ms(o.expiresAt ?? o.resetsAt);
        return {
          kind: "reset",
          id: `reset|${o.provider}|${o.entitlement}|${expiresAt ?? ""}`,
          label: "Banked reset",
          available: o.remaining === 1,
          expiresAt
        };
      }
      default:
        return null;
    }
  }
  function parentId(row) {
    const hash = row.id.indexOf("#");
    const lastPipe = row.id.lastIndexOf("|");
    return hash !== -1 && hash < lastPipe ? row.id.slice(0, hash) + row.id.slice(lastPipe) : null;
  }
  function foldSegments(rows, provider) {
    if (provider !== "grok")
      return rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const folded = new Set;
    for (const r of rows) {
      const pid = parentId(r);
      const parent = pid ? byId.get(pid) : undefined;
      if (r.kind !== "allowance" || parent?.kind !== "allowance")
        continue;
      parent.segments.push({ name: r.label, fractionUsed: r.fractionUsed });
      folded.add(r.id);
    }
    for (const r of rows)
      if (r.kind === "allowance")
        r.segments.sort((a, b) => (b.fractionUsed ?? 0) - (a.fractionUsed ?? 0));
    return rows.filter((r) => !folded.has(r.id));
  }
  function uniqueIds(rows) {
    const seen = new Map;
    return rows.map((r) => {
      const n = seen.get(r.id) ?? 0;
      seen.set(r.id, n + 1);
      return n === 0 ? r : { ...r, id: `${r.id}~${n}` };
    });
  }
  function rowRank(r) {
    if (r.kind !== "allowance" || !r.window)
      return 99;
    return windowRank[r.window] ?? 50;
  }
  function carryForward(next, previous) {
    if (!previous)
      return next;
    const reporting = new Set(next.observations.map((o) => o.provider));
    const unreachable = new Set((next.adapters ?? []).filter((a) => a.status === "unavailable").map((a) => a.provider));
    const carried = previous.observations.filter((o) => unreachable.has(o.provider) && !reporting.has(o.provider)).map((o) => ({ ...o, stale: true }));
    return carried.length === 0 ? next : { ...next, observations: [...next.observations, ...carried] };
  }
  function ordered(items, order, id) {
    if (!order || order.length === 0)
      return items;
    const rank = new Map;
    order.forEach((key, i) => {
      if (!rank.has(key))
        rank.set(key, i);
    });
    return items.map((item, i) => ({ item, i, r: rank.get(id(item)) ?? order.length })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.item);
  }
  function reordered(ids, moving, target) {
    const from = ids.indexOf(moving);
    const to = ids.indexOf(target);
    if (moving === target || from === -1 || to === -1)
      return [...ids];
    const next = ids.filter((id) => id !== moving);
    next.splice(to, 0, moving);
    return next;
  }
  function overallReading(sections) {
    let five = 0, fiveW = 0, seven = 0, sevenW = 0;
    for (const s of sections) {
      const allowances = s.rows.filter((r) => r.kind === "allowance" && r.fractionUsed != null && !parentId(r));
      const weekly = allowances.find((r) => r.window === "wk")?.fractionUsed ?? null;
      const fiveHour = allowances.find((r) => r.window === "5h")?.fractionUsed ?? null;
      const dollars = s.plan?.dollars ?? FALLBACK_DOLLARS;
      const f = Math.max(fiveHour ?? -1, weekly ?? -1);
      if (f >= 0) {
        five += f * dollars;
        fiveW += dollars;
      }
      if (weekly != null) {
        seven += weekly * dollars;
        sevenW += dollars;
      }
    }
    return { fiveHour: fiveW > 0 ? five / fiveW : null, sevenDay: sevenW > 0 ? seven / sevenW : null };
  }
  function buildView(snapshot, order = {}) {
    const groups = new Map;
    for (const o of snapshot.observations) {
      if (toRow(o) === null)
        continue;
      const account = entitlementParts(o.entitlement).account;
      const id = `${o.provider}|${account ?? ""}`;
      if (!groups.has(id))
        groups.set(id, { provider: o.provider, account, obs: [] });
      groups.get(id).obs.push(o);
    }
    for (const [id, g] of [...groups]) {
      if (g.account)
        continue;
      const named = [...groups.values()].filter((x) => x.provider === g.provider && x.account);
      if (named.length === 1) {
        named[0].obs.push(...g.obs);
        groups.delete(id);
      }
    }
    const subscriptions = new Map((snapshot.subscriptions ?? []).map((s) => [`${s.provider}|${s.account ?? ""}`, s]));
    for (const [id, s] of subscriptions) {
      if (!groups.has(id))
        groups.set(id, { provider: s.provider, account: s.account ?? null, obs: [] });
    }
    const sections = [...groups].map(([id, g]) => {
      const rows = uniqueIds(g.obs.map(toRow).filter((r) => r !== null));
      const natural = foldSegments(rows, g.provider).map((r, i) => ({ r, i })).sort((a, b) => rowRank(a.r) - rowRank(b.r) || a.i - b.i).map((x) => x.r);
      const sub = subscriptions.get(id);
      const staleTimes = natural.flatMap((r) => r.kind === "allowance" && r.stale && r.observedAt != null ? [r.observedAt] : []);
      return {
        id,
        provider: g.provider,
        title: providerTitle[g.provider] ?? g.provider,
        account: g.account,
        plan: sub ? { name: sub.planName, dollars: sub.monthlyDollars } : g.provider === "anthropic" ? planFromTier(g.obs.find((o) => o.tier)?.tier) : null,
        renewsOn: sub?.renewsOn ?? null,
        rows: ordered(natural, order.rows?.[id], (r) => r.id),
        staleSince: staleTimes.length ? Math.min(...staleTimes) : null
      };
    });
    const withPlan = sections.filter((s) => s.plan);
    return {
      sections: ordered(sections, order.sections, (s) => s.id),
      overall: overallReading(sections),
      bill: { total: withPlan.reduce((sum, s) => sum + s.plan.dollars, 0), planCount: withPlan.length },
      notes: (snapshot.adapters ?? []).filter((a) => a.status !== "ok").map((a) => `${providerTitle[a.provider] ?? a.provider}: ${a.detail ?? a.status}`)
    };
  }
  function shortAge(at, now) {
    const minutes = Math.max(0, Math.round((now - at) / 60000));
    if (minutes < 60)
      return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
  }
  function renewalLabel(renewsOn) {
    const t = Date.parse(`${renewsOn}T00:00:00Z`);
    if (Number.isNaN(t))
      return renewsOn;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const d = new Date(t);
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }

  // packages/usage-view/jsc-entry.ts
  globalThis.usageView = {
    build(snapshotJson, previousJson, orderJson) {
      const next = JSON.parse(snapshotJson);
      const previous = previousJson ? JSON.parse(previousJson) : null;
      const snapshot = carryForward(next, previous);
      return JSON.stringify({ snapshot, view: buildView(snapshot, JSON.parse(orderJson)) });
    },
    reordered(idsJson, moving, target) {
      return JSON.stringify(reordered(JSON.parse(idsJson), moving, target));
    },
    shortAge,
    renewalLabel
  };
})();
