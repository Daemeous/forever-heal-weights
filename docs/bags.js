// Best in bags: reads a MythicSim / voidsim.io Forever export (or anything with {"id": ...} items in it), and picks the
// best gear the character owns for the stat weights the page worked out. Runs in the browser and in Node.
(function (root) {
  "use strict";
  // item table row: [name, invType, itemClass, subclass, reqLevel, quality, heal, crit %, int, spi, mp5, classMask, unique]
  var CLASS_BIT = { Paladin: 2, Priest: 16, Shaman: 64, Druid: 1024 };
  var ARMOR = { Priest: [0, 1], Paladin: [0, 1, 2, 3, 4, 6, 7], Shaman: [0, 1, 2, 3, 6, 9], Druid: [0, 1, 2, 8] };
  var WEAPON = { Priest: [4, 10, 15, 19], Paladin: [0, 1, 4, 5, 6, 7, 8], Shaman: [0, 1, 4, 5, 10, 13, 15], Druid: [4, 5, 6, 10, 13, 15] };
  var SLOTS = [   // [label, inventory types]
    ["Head", [1]], ["Neck", [2]], ["Shoulder", [3]], ["Back", [16]], ["Chest", [5, 20]], ["Wrist", [9]], ["Hands", [10]],
    ["Waist", [6]], ["Legs", [7]], ["Feet", [8]], ["Ring", [11], 2], ["Trinket", [12], 2], ["Ranged / relic", [15, 25, 26, 28]],
  ];
  var MAIN = [13, 21], TWOH = [17], OFF = [14, 23];

  // SimulationCraft addon (/simc): equipped items are "slot=,id=N,..." lines; bags (and the bank, once opened with the
  // addon loaded) are the same lines commented out with "#" under "### Gear from Bags" / "### Gear from Bank"
  var SIMC_SLOT = /^\s*(#\s*)?(head|neck|shoulders?|back|chest|shirt|tabard|wrists?|hands|waist|legs|feet|finger[12]|trinket[12]|main_hand|off_hand|ranged)=[^\n]*?\bid=(\d+)/;
  function parseSimc(text) {
    var equipped = [], owned = [], bank = /###\s*Gear from Bank/i.test(text);
    text.split(/\r?\n/).forEach(function (l) {
      var m = l.match(SIMC_SLOT);
      if (!m) return;
      owned.push(+m[3]);
      if (!m[1]) equipped.push(+m[3]);
    });
    var c = text.match(/^\s*(warrior|paladin|hunter|rogue|priest|shaman|mage|warlock|druid)="?([^"\n]*)"?/m);
    var lv = text.match(/^\s*level=(\d+)/m);
    if (!owned.length) throw new Error("No items found in that SimulationCraft text - copy the whole /simc window.");
    return { equipped: equipped, owned: owned, cls: c ? c[1][0].toUpperCase() + c[1].slice(1) : null,
             level: lv ? +lv[1] : null, name: c ? c[2] : null, bank: bank, format: "SimulationCraft" };
  }

  // JSON exports (MythicSim, voidsim.io): every {"id": n} in an "items" array; items under "gear" are equipped
  function parseExport(text) {
    var T = String(text);
    if (!/^\s*\{/.test(T) && T.split(/\r?\n/).some(function (l) { return SIMC_SLOT.test(l); })) return parseSimc(T);
    var data;
    try { data = JSON.parse(String(text).trim()); }
    catch (e) {
      var m = String(text).match(/\{[\s\S]*\}/);                       // tolerate text around the JSON
      if (!m) throw new Error("That doesn't look like a MythicSim or voidsim export (no JSON found).");
      data = JSON.parse(m[0]);
    }
    var equipped = [], owned = [];
    // items live in "items" arrays (gear.items, bags.items, bank.items, ...) as {"id": n, ...} or null
    (function walk(o, inGear) {
      if (!o || typeof o !== "object") return;
      for (var k in o) {
        var v = o[k], g = inGear || k === "gear";
        if (k === "items" && Array.isArray(v)) {
          v.forEach(function (x) {
            var id = x && typeof x === "object" ? +x.id : +x;
            if (id > 0) { owned.push(id); if (g) equipped.push(id); }
          });
        } else if (v && typeof v === "object") walk(v, g);
      }
    })(data, false);
    if (!owned.length) throw new Error("No items found in that text - paste the whole export from the MythicSim or voidsim addon.");
    var cls = data.class || (data.character && data.character.class) || null;
    var level = data.level || (data.character && data.character.level) || null;
    return { equipped: equipped, owned: owned, cls: cls, level: level, name: data.name || null,
             bank: !!(data.bank), format: /voidsim/i.test(data.version || "") ? "voidsim.io" : data.mythicsim ? "MythicSim" : "export" };
  }

  function usable(row, cls, level) {
    if (!row) return false;
    if (level && row[4] > level) return false;
    if (row[11] !== -1 && CLASS_BIT[cls] && !(row[11] & CLASS_BIT[cls])) return false;
    if (row[2] === 4) return (ARMOR[cls] || [0, 1, 2, 3, 4, 6]).indexOf(row[3]) >= 0;
    if (row[2] === 2) return (WEAPON[cls] || []).indexOf(row[3]) >= 0;
    return true;
  }

  // stats, plus the estimated worth of the item's on-use / proc effect when ctx (see procValue) is given
  function value(row, w, ctx, id) {
    if (!row) return 0;
    var v = w.healing * row[6] + w.critPct * row[7] + w.intellect * row[8] + w.spirit * row[9] + w.mp5 * row[10];
    var P = ctx && ctx.procs && ctx.procs.items[id];
    return P ? v + procValue(P, ctx).v : v;
  }

  // ------------------------------------------------------------------ on-use and proc effects
  // ctx: { w (weights per +1 healing), lambda (healing per mana; 0 = throughput view), L (fight length, sec),
  //        r (the scope's evaluate() result: healPerPoint, eff, overPct, spentHeal, spells, rates), spirit, procs }
  // Rates are per second of casting (rates.active), so downtime in the log doesn't dilute them.
  // Returns { v: worth in +healing, how: short explanation }.
  function procValue(P, ctx) {
    var w = ctx.w, lam = ctx.lambda || 0, L = Math.max(10, ctx.L || 180), r = ctx.r || {}, R = r.rates || {};
    var act = R.active > 0 ? R.active : (r.duration || 0), hd = r.healPerPoint || 0;
    if (!(act > 0) || !(hd > 0)) return { v: 0, how: "no data" };
    var h1 = hd / act;                                   // healing per +1 healing per second of casting
    var fightEq = function (H) { return H / (h1 * L); };  // healing over one fight -> +healing
    var logEq = function (H) { return H / hd; };          // healing over the whole scope -> +healing
    var healRate = (R.healCasts || 0) / act, castRate = (R.nCasts || 0) / act;
    var perCast = R.healCasts ? hd / R.healCasts : 0;     // healing per +1 healing, per heal cast
    var effRate = (r.eff || 0) / act, over = r.overPct || 0, manaRate = (r.spentHeal || 0) / act;
    // on-use: replayed over the log's pulls (cdModel) - how far into each fight the cooldown is back
    var cdm = P.cd ? cdModel(P.cd, ctx) : null;
    var uses = cdm ? cdm.uses(L) : 1;
    var up = function (d) { return Math.min(1, cdm ? cdm.cover(d, L) / L : d / L); };
    var pct = function (x) { return Math.round(x * 100) + "%"; };
    var spells = {};
    (r.spells || []).forEach(function (x) { spells[x.name] = x; });
    var sum = function (names, f) { return (names || []).reduce(function (t, n) { return t + f(n); }, 0); };
    var un = Math.abs(uses - Math.round(uses)) < 0.05 ? Math.round(uses) : +uses.toFixed(1);
    var usesTxt = un + (un === 1 ? " use" : " uses") + " per fight" +
      (cdm ? (cdm.n ? ", ready at the pull for " + pct(cdm.ready) + " of " + cdm.n + " " + cdm.what : ", no pulls in the log: ready every fight") : "");
    var none = function (names) { return "you don't cast " + names.join(" / "); };
    var cpd, n, pts, k;
    switch (P.kind) {
      case "buff":
        return { v: statValue(P.s, w) * up(P.dur), how: P.dur >= P.cd && up(P.dur) > 0.99 ? "always up (lasts " + Math.round(P.dur / 60) +
                 " min, cooldown " + Math.round(P.cd / 60) + " min)" : "up " + pct(up(P.dur)) + " of the fight (" + usesTxt + ")" };
      case "mana": {
        var v = fightEq(lam * P.mana * uses), how = Math.round(P.mana * uses) + " mana (" + usesTxt + ")";
        if (P.then) v += statValue(P.then.s, w) * up(P.then.dur);
        return { v: v, how: how };
      }
      case "costCut": {
        var avg = R.healCasts ? (r.spentHeal || 0) / R.healCasts : 0;
        cpd = castRate * P.dur;
        var m = Math.min(P.per, avg) * cpd * uses;
        return { v: fightEq(lam * m), how: "~" + cpd.toFixed(1) + " casts per use, " + Math.round(m) + " mana" };
      }
      case "costPct": {
        var mana = (P.pct / 100) * manaRate * P.dur * uses, H = lam * mana;
        if (P.heal) H += (P.heal / 100) * effRate * (1 - over) * P.dur * uses;
        return { v: fightEq(H), how: (P.heal ? "+" + P.heal + "% healing, " : "") + Math.round(mana) + " mana (" + usesTxt + ")" };
      }
      case "critUntil": {
        var c = (r.critRate || 0) + P.pct / 100;
        var secs = Math.min(P.dur, healRate > 0 ? 1 / (c * healRate) : P.dur);
        return { v: (w.critPct || 0) * P.pct * up(secs), how: "lasts ~" + secs.toFixed(0) + " s (ends at your next crit)" };
      }
      case "decay":
        n = Math.min(Math.floor(P.start / P.step), Math.round(healRate * P.dur));
        for (pts = 0, k = 0; k < n; k++) pts += P.start - P.step * k;
        return { v: fightEq(pts * perCast * uses), how: "~" + n + " casts per use, average +" + Math.round(n ? pts / n : 0) };
      case "ramp":
        n = Math.min(P.n, Math.round(healRate * P.dur));
        for (pts = 0, k = 1; k < n; k++) pts += P.per * Math.min(k, P.max);
        return { v: fightEq(pts * perCast * uses), how: n + " casts per use" };
      case "charges":
        n = Math.min(P.n, Math.round(healRate * P.dur));
        return { v: fightEq(P.heal * n * perCast * uses), how: n + " casts per use" };
      case "heal":
        return { v: fightEq(P.amount * P.targets * (1 - over) * uses), how: usesTxt + ", less your overheal " + pct(over) };
      case "absorb":
        return { v: fightEq(P.pct / 100 * effRate * P.dur * uses), how: usesTxt + ", every shield used" };
      case "stat":
        return { v: statValue(P.s, w), how: "" };
      case "proc": {
        var trig = P.spells ? sum(P.spells, function (x) { return (R.casts || {})[x] || 0; }) / act : castRate;
        if (P.mana) {                     // mana on a share of casts
          var pm = Math.min(1, P.chance / 100) * (R.nCasts || 0) * P.mana;
          return { v: logEq(lam * pm), how: Math.round(pm) + " mana in this log (" + P.chance + "% of " + (R.nCasts || 0) + " casts)" };
        }
        var p = Math.min(1, P.chance / 100) * trig, upt = 0;
        if (p > 0) upt = P.icd >= P.dur ? P.dur / (P.icd + 1 / p) : 1 - Math.exp(-p * P.dur);
        var s = P.s || [0, 0, 0, (ctx.spirit || 0) * (P.spiPct || 0) / 100, 0];
        return { v: statValue(s, w) * upt, how: P.spells && !trig ? none(P.spells) :
                 "up ~" + pct(upt) + (P.spiPct ? " (+" + Math.round(s[3]) + " Spirit)" : "") };
      }
      case "procHeal": {               // a HoT on a share of heals, at most once per icd
        var ph = Math.min(healRate * P.chance / 100, P.icd ? 1 / P.icd : Infinity) * act;
        var hh = ph * P.amount * (1 - over);
        return { v: logEq(hh), how: Math.round(ph) + " procs in this log, less your overheal " + pct(over) };
      }
      case "lowMana":
        return (r.minMana != null ? r.minMana : 1) <= 0.15 ? { v: fightEq(lam * P.mana), how: P.mana + " mana once per fight (your mana went under 15%)" }
          : { v: 0, how: "your mana never went under 15% here" };
      case "casting": {                // share of Spirit regen kept while casting
        var spi = ctx.spirit || 0, rg = Math.min(spi / 4, 6.25 + spi / 8);
        var cm = P.pct / 100 * rg * (r.tIn || 0);
        return { v: logEq(lam * cm), how: Math.round(cm) + " mana in this log (" + Math.round(r.tIn || 0) + " s casting, " + spi + " Spirit)" };
      }
      case "spellCritMana": {
        var cmn = sum(P.spells, function (x) { return spells[x] && spells[x].hits ? spells[x].mana * spells[x].crits / spells[x].hits : 0; }) * P.pct / 100;
        return { v: logEq(lam * cmn), how: cmn ? Math.round(cmn) + " mana in this log" : none(P.spells) };
      }
      case "spellCritHeal": {
        var ncr = sum(P.spells, function (x) { return spells[x] ? spells[x].crits : 0; });
        return { v: logEq(ncr * P.amount * (1 - over)), how: ncr ? ncr + " crits in this log, every shield used" : none(P.spells) };
      }
      case "spellPct": {
        var se = sum(P.spells, function (x) { return spells[x] ? spells[x].eff : 0; }) * P.pct / 100;
        return { v: logEq(se), how: se ? "+" + P.pct + "% of your " + P.spells.join(" / ") + " healing" : none(P.spells) };
      }
      case "spellCost": {
        var sm = sum(P.spells, function (x) { return spells[x] ? spells[x].mana : 0; }) * P.pct / 100;
        return { v: logEq(lam * sm), how: sm ? Math.round(sm) + " mana saved in this log" : none(P.spells) };
      }
      case "spellMana": {
        var gm = sum(P.spells, function (x) { return (R.casts || {})[x] || 0; }) * P.mana;
        return { v: logEq(lam * gm), how: gm ? Math.round(gm) + " mana in this log" : none(P.spells) };
      }
      case "spellCrit": {
        var cd = sum(P.spells, function (x) { return spells[x] ? spells[x].critD : 0; }) / 100 * P.pct;
        return { v: logEq(cd), how: cd ? "from your " + P.spells.join(" / ") + " heals in this log" : none(P.spells) };
      }
    }
    return { v: 0, how: P.note || "not scored" };
  }

  // w: weights relative to +1 healing ({healing, critPct (+1% crit), intellect, spirit, mp5})
  // On-use cooldowns replayed over the log's pulls (ctx.pulls from engine.analyse: boss fights + trash pulls). Used at the
  // first moment it's ready in a pull, again on cooldown. Saved for bosses (ctx.policy "boss", the default) it's only used
  // in boss fights; "all" uses it on trash too. Each counted pull gives an offset (sec into the fight until it's ready),
  // which is then applied to a fight of the chosen length L. Pulls counted: boss pulls, or every pull (ctx.countAll).
  function cdModel(cd, ctx) {
    var C = ctx._cd || (ctx._cd = {}), key = cd + "|" + ctx.policy + "|" + !!ctx.countAll;
    if (C[key]) return C[key];
    var pulls = ctx.pulls || [], anyBoss = pulls.some(function (x) { return x.boss; });
    var bossOnly = ctx.policy !== "all" && anyBoss, countAll = ctx.countAll && !bossOnly;
    var ready = -Infinity, offs = [];
    pulls.forEach(function (pl) {
      if (bossOnly && !pl.boss) return;
      var o = Math.max(0, ready - pl.s);
      if (pl.boss || countAll || !anyBoss) offs.push(o);
      for (var t = pl.s + o; t < pl.e; t += cd) ready = t + cd;
    });
    var n = offs.length;
    if (!n) offs = [0];
    function uses(L) {
      return offs.reduce(function (a, o) { return a + (o < L ? Math.floor((L - o - 1e-6) / cd) + 1 : 0); }, 0) / offs.length;
    }
    function cover(d, L) {
      return offs.reduce(function (a, o) { for (var t = o; t < L; t += cd) a += Math.min(d, L - t); return a; }, 0) / offs.length;
    }
    return (C[key] = { uses: uses, cover: cover, n: n, what: countAll || !anyBoss ? "pulls" : "boss pulls",
                       ready: n ? offs.filter(function (o) { return o === 0; }).length / n : 1 });
  }

  // ------------------------------------------------------------------ set bonuses (ctx.procs.sets, from tools/gen_procs.py)
  // Only pieces in one-item slots count (every healer set is armor). Bonuses are worth their stats, or procValue.
  var SINGLE = SLOTS.filter(function (s) { return !s[2]; });
  function bonusValue(b, ctx) { return b.kind === "stat" ? statValue(b.s, ctx.w) : procValue(b, ctx).v; }
  function setBonusV(S, k, ctx) {
    return S.b.reduce(function (t, b) { return t + (b.k <= k ? bonusValue(b, ctx) : 0); }, 0);
  }
  // best number of pieces of set sid to wear on top of the per-slot picks (pick: slot label -> item with .v; cands(slot)
  // -> that slot's candidates best first; locked: slots already given to another set). Gain can be negative.
  function evalSet(sid, pick, cands, ctx, locked) {
    var S = ctx.procs.sets[sid], mem = {};
    S.items.forEach(function (i) { mem[i] = 1; });
    var opts = [];
    SINGLE.forEach(function (sl) {
      var L = sl[0], cur = pick[L];
      if (locked[L]) { if (mem[locked[L].id]) opts.push({ slot: L, it: locked[L], loss: 0 }); return; }
      var p = cands(sl).filter(function (x) { return mem[x.id]; })[0];
      if (p) opts.push({ slot: L, it: p, loss: (cur ? cur.v : 0) - p.v });
    });
    opts.sort(function (a, b) { return a.loss - b.loss; });
    var best = null;
    S.b.forEach(function (b) {
      if (b.k > opts.length) return;
      var use = opts.slice(0, b.k), loss = use.reduce(function (t, o) { return t + o.loss; }, 0), bv = setBonusV(S, b.k, ctx);
      if (bv > 0 && (!best || bv - loss > best.gain)) best = { sid: sid, name: S.n, k: b.k, v: bv, gain: bv - loss, pieces: use };
    });
    return best || { sid: sid, name: S.n, k: 0, v: 0, gain: 0, pieces: [], have: opts.length };
  }
  // sets worth wearing, best gain first, each one locking its slots
  function pickSets(sids, pick, cands, ctx) {
    var locked = {}, chosen = [];
    for (;;) {
      var best = null;
      sids.forEach(function (sid) { var e = evalSet(sid, pick, cands, ctx, locked); if (e.gain > 0.5 && (!best || e.gain > best.gain)) best = e; });
      if (!best) break;
      best.pieces.forEach(function (o) { locked[o.slot] = o.it; });
      chosen.push(best);
      sids = sids.filter(function (x) { return x !== best.sid; });
    }
    return { locked: locked, chosen: chosen };
  }
  // stat vectors [healing, % crit, Int, Spirit, MP5]: an item's, a set's active stat bonuses, sums and differences
  function stOf(x) { return x && x.st ? x.st : [0, 0, 0, 0, 0]; }
  function stAdd(a, b, sign) { return a.map(function (v, i) { return v + (sign || 1) * b[i]; }); }
  function setStats(S, k) {
    var st = [0, 0, 0, 0, 0], other = [];
    S.b.forEach(function (b) { if (b.k > k) return; if (b.kind === "stat") st = stAdd(st, b.s); else if (b.kind !== "none") other.push(b.text); });
    return { st: st, other: other };
  }
  function setsWith(ids, ctx) {
    var have = {}, out = [];
    ids.forEach(function (id) { have[id] = 1; });
    var SS = ctx && ctx.procs && ctx.procs.sets || {};
    for (var sid in SS) if (SS[sid].items.some(function (i) { return have[i]; })) out.push(sid);
    return out;
  }

  function bestInBags(exp, cls, level, w, ITEMS, ctx) {
    var I = ITEMS.items, unknown = 0, counts = {};
    exp.owned.forEach(function (id) { counts[id] = (counts[id] || 0) + 1; if (!I[id]) unknown++; });
    var pool = Object.keys(counts).filter(function (id) { return usable(I[id], cls, level); })
      .map(function (id) { var r = I[id]; return { id: +id, name: r[0], inv: r[1], copies: counts[id], unique: r[12], v: value(r, w, ctx, id), row: r, st: r.slice(6, 11) }; });
    var eq = exp.equipped.filter(function (id) { return I[id]; })
      .map(function (id) { var r = I[id]; return { id: id, name: r[0], inv: r[1], v: value(r, w, ctx, id), row: r, st: r.slice(6, 11) }; });
    function top(types, n) {
      var c = [];
      pool.filter(function (x) { return types.indexOf(x.inv) >= 0; }).forEach(function (x) {
        for (var k = 0; k < (x.unique ? 1 : Math.min(x.copies, n)); k++) c.push(x);
      });
      return c.sort(function (a, b) { return b.v - a.v; }).slice(0, n);
    }
    function worn(types, n) {
      return eq.filter(function (x) { return types.indexOf(x.inv) >= 0; }).sort(function (a, b) { return b.v - a.v; }).slice(0, n);
    }
    // set bonuses: pieces you own, worn where the bonus beats the per-slot pick; what's worn now counts its active bonuses
    var pick = {}, cc = {}, SP = { locked: {}, chosen: [] };
    SINGLE.forEach(function (sl) { pick[sl[0]] = top(sl[1], 1)[0] || null; });
    if (ctx && ctx.procs && ctx.procs.sets) {
      SP = pickSets(setsWith(pool.map(function (x) { return x.id; }), ctx), pick, function (sl) { return cc[sl[0]] || (cc[sl[0]] = top(sl[1], 99)); }, ctx);
    }
    var rows = [];
    SLOTS.forEach(function (s) {
      var n = s[2] || 1, best = SP.locked[s[0]] ? [SP.locked[s[0]]] : top(s[1], n), cur = worn(s[1], n);
      // two-slot pairs (rings, trinkets): items already worn stay in their row, only the real swap shows
      var keep = [], restC = cur.slice(), restB = [];
      best.forEach(function (b) {
        var j = restC.findIndex(function (c) { return c.id === b.id; });
        if (j >= 0) { keep.push(b); restC.splice(j, 1); } else restB.push(b);
      });
      var pairs = keep.map(function (k) { return [k, k]; });
      for (var i = 0; pairs.length < n; i++) pairs.push([restC[i] || null, restB[i] || restC[i] || null]);
      var t1 = SP.locked[s[0]] ? top(s[1], 1)[0] : null, instead = t1 && t1.id !== SP.locked[s[0]].id ? t1 : null;
      pairs.forEach(function (pr, i) {
        var cs = pr[1] && SP.chosen.filter(function (c) { return ctx.procs.sets[c.sid].items.indexOf(+pr[1].id) >= 0; })[0];
        rows.push({ slot: s[0] + (n > 1 ? " " + (i + 1) : ""), cur: pr[0], best: pr[1], set: cs ? cs.name + " (" + cs.k + "-piece bonus)" : null, instead: instead });
      });
    });
    // weapons: best two-hander vs best main hand + off hand, shown as one row with the net gain
    var b2 = top(TWOH, 1)[0], bm = top(MAIN, 1)[0], bo = top(OFF, 1)[0];
    var pairV = (bm ? bm.v : 0) + (bo ? bo.v : 0), twoV = b2 ? b2.v : -1;
    var cm = worn(MAIN.concat(TWOH), 1)[0] || null, co = worn(OFF, 1)[0] || null;
    function combo(a, b) {
      if (!a && !b) return null;
      if (!b) return a;
      if (!a) return b;
      return { id: a.id + "+" + b.id, name: a.name + " + " + b.name, v: a.v + b.v, st: stAdd(stOf(a), stOf(b)) };
    }
    rows.push({ slot: "Weapons", cur: combo(cm, co), best: twoV > pairV ? b2 : combo(bm || cm, bo || co) });
    if (ctx && ctx.procs && ctx.procs.sets) {
      var SS = ctx.procs.sets, wornSets = [], wv = 0, wst = [0, 0, 0, 0, 0], wo = [];
      setsWith(eq.map(function (x) { return x.id; }), ctx).forEach(function (sid) {
        var S = SS[sid], k = eq.filter(function (x) { return S.items.indexOf(+x.id) >= 0; }).length, v = setBonusV(S, k, ctx);
        if (v > 0) { wornSets.push(S.n + " " + k + "pc"); wv += v; var ss = setStats(S, k); wst = stAdd(wst, ss.st); wo = wo.concat(ss.other); }
      });
      var bn = SP.chosen.map(function (c) { return c.name + " " + c.k + "pc"; }), bv = SP.chosen.reduce(function (t, c) { return t + c.v; }, 0);
      var bst = [0, 0, 0, 0, 0], bo = [];
      SP.chosen.forEach(function (c) { var ss = setStats(SS[c.sid], c.k); bst = stAdd(bst, ss.st); bo = bo.concat(ss.other); });
      if (wornSets.length || bn.length) {
        rows.push({ slot: "Set bonuses", cur: wornSets.length ? { id: wornSets.join(), name: wornSets.join(", "), v: wv, st: wst, other: wo } : null,
                    best: bn.length ? { id: bn.join(), name: bn.join(", "), v: bv, st: bst, other: bo } : null });
      }
    }
    var total = 0, dst = [0, 0, 0, 0, 0];
    rows.forEach(function (r) {
      r.dst = stAdd(stOf(r.best), stOf(r.cur), -1);
      r.gain = (r.best ? r.best.v : 0) - (r.cur ? r.cur.v : 0);
      r.change = !!(r.best && (!r.cur || r.best.id !== r.cur.id));
      total += r.gain;
      if (r.change) dst = stAdd(dst, r.dst);
    });
    return { rows: rows, total: total, dst: dst, unknown: unknown, owned: exp.owned.length, equippedKnown: eq.length, sets: SP.chosen };
  }

  // ------------------------------------------------------------------ best in slot from the whole item database
  // opts.tiers: which sources to allow - P dungeon/quest/crafted/rep/vendor, V PvP, R Classic raid (not in Forever's
  // raids), L later content, F other faction, "" no known source. opts.n: how many per slot.
  function bisList(cls, level, w, ITEMS, opts) {
    var I = ITEMS.items, n = opts.n || 3, tiers = opts.tiers || { P: 1 };
    function allowed(r) {
      var t = r[13] || "";
      if (!t) return !!tiers[""];
      for (var i = 0; i < t.length; i++) if (tiers[t[i]]) return true;
      return false;
    }
    var pool = [];
    for (var id in I) {
      var r = I[id];
      if (!usable(r, cls, level) || !allowed(r)) continue;
      pool.push({ id: +id, name: r[0], inv: r[1], v: value(r, w, opts.ctx, id), proc: !!(opts.ctx && opts.ctx.procs && opts.ctx.procs.items[id]), src: r[14] || "source unknown", tier: r[13] || "", unique: r[12], st: r.slice(6, 11) });
    }
    function top(types, k) {
      return pool.filter(function (x) { return types.indexOf(x.inv) >= 0; }).sort(function (a, b) { return b.v - a.v; }).slice(0, k);
    }
    var rows = SLOTS.map(function (sl) { return { slot: sl[0] + (sl[2] ? "s" : ""), items: top(sl[1], n + (sl[2] ? 1 : 0)) }; });
    // set bonuses against the #1 pick per slot: each set on its own (best number of pieces), and the ones worth wearing
    rows.sets = []; rows.setPick = [];
    if (opts.ctx && opts.ctx.procs && opts.ctx.procs.sets) {
      var pick = {}, cc = {}, cands = function (sl) { return cc[sl[0]] || (cc[sl[0]] = top(sl[1], 999)); };
      SINGLE.forEach(function (sl) { pick[sl[0]] = top(sl[1], 1)[0] || null; });
      var sids = setsWith(pool.map(function (x) { return x.id; }), opts.ctx);
      rows.sets = sids.map(function (sid) { return evalSet(sid, pick, cands, opts.ctx, {}); }).filter(function (e) { return e.k; })
        .sort(function (a, b) { return b.gain - a.gain; });
      var SP = pickSets(sids, pick, cands, opts.ctx);
      rows.setPick = SP.chosen;
    }
    // the merged gear set: one pick per slot, set pieces where a chosen set beats the per-slot picks, the better
    // weapon setup, and the set bonuses; total = everything added up
    var gear = [], setOf = {};
    (rows.setPick || []).forEach(function (c) { c.pieces.forEach(function (o) { setOf[o.slot] = { set: c, loss: o.loss }; }); });
    SLOTS.forEach(function (sl) {
      if (!sl[2]) {
        var L = sl[0], s = setOf[L];
        if (s) gear.push({ slot: L, it: s.set.pieces.filter(function (o) { return o.slot === L; })[0].it, set: s.set.name + " (" + s.set.k + "-piece bonus)",
                           instead: s.loss > 0.5 ? top(sl[1], 1)[0] : null, loss: s.loss });
        else { var b = top(sl[1], 1)[0]; if (b) gear.push({ slot: L, it: b }); }
        return;
      }
      var t = top(sl[1], 2);
      if (t[0]) gear.push({ slot: sl[0] + " 1", it: t[0] });
      if (t[1]) gear.push({ slot: sl[0] + " 2", it: t[1] });   // two different items (the unique flag is often missing)
    });
    var w2 = top(TWOH, 1)[0], wm = top(MAIN, 1)[0], wo = top(OFF, 1)[0];
    if (w2 && w2.v >= (wm ? wm.v : 0) + (wo ? wo.v : 0)) gear.push({ slot: "Two-hand", it: w2 });
    else { if (wm) gear.push({ slot: "Main hand", it: wm }); if (wo) gear.push({ slot: "Off hand", it: wo }); }
    var bonus = (rows.setPick || []).reduce(function (t, c) { return t + c.v; }, 0);
    // per set: stats of its pieces minus the items they replace, plus its bonuses (vs the best single items)
    (rows.setPick || []).forEach(function (c) {
      var ss = setStats(opts.ctx.procs.sets[c.sid], c.k), d = ss.st;
      c.pieces.forEach(function (o) {
        var sl = SINGLE.filter(function (x) { return x[0] === o.slot; })[0], t1 = top(sl[1], 1)[0];
        d = stAdd(stAdd(d, stOf(o.it)), stOf(t1), -1);
      });
      c.dst = d; c.other = ss.other; c.bst = ss.st;
    });
    var gst = [0, 0, 0, 0, 0];
    gear.forEach(function (g) { gst = stAdd(gst, stOf(g.it)); });
    (rows.setPick || []).forEach(function (c) { gst = stAdd(gst, c.bst); });
    rows.gear = { items: gear, sets: rows.setPick || [], bonus: bonus,
                  total: gear.reduce(function (t, g) { return t + g.it.v; }, 0) + bonus, st: gst };
    rows.push({ slot: "Two-hand", items: top(TWOH, n) });
    rows.push({ slot: "Main hand / one-hand", items: top(MAIN, n) });
    rows.push({ slot: "Off hand / shield", items: top(OFF, n) });
    return rows;
  }

  function statValue(st, w) {
    return w.healing * st[0] + w.critPct * st[1] + w.intellect * st[2] + w.spirit * st[3] + w.mp5 * st[4];
  }

  // enchants and consumables in +healing equivalents. ctx: { w, lambda, h1 (healing per +1 healing per second),
  // L (fight length, sec) }. Mana is worth lambda healing each (0 in the throughput view).
  function extrasValues(EX, ctx) {
    var w = ctx.w, L = Math.max(10, ctx.L || 180);
    var PE = ctx.procs && ctx.procs.enchants || {};
    var ench = EX.enchants.map(function (e) {
      var o = Object.assign({ v: statValue(e.s, w) }, e);
      if (PE[e.n]) { var pv = procValue(PE[e.n], ctx); o.v += pv.v; o.est = pv.how; }
      return o;
    });
    var cons = EX.consumables.map(function (c) {
      var uses = c.cd ? Math.ceil(L / c.cd) : 1;
      var uptime = c.up ? Math.min(1, c.up * uses / L) : 1;
      var manaHeal = ((c.mana || 0) * uses + (c.maxMana || 0)) * ctx.lambda;
      var manaEq = ctx.h1 > 0 ? manaHeal / (ctx.h1 * L) : 0;
      return Object.assign({ v: statValue(c.s, w) * uptime + manaEq, manaHeal: manaHeal, uses: uses, uptime: uptime }, c);
    });
    return { enchants: ench, consumables: cons };
  }

  // every on-use / proc item this class can use, valued (ctx as procValue), best first
  function procList(cls, level, ctx, ITEMS) {
    var I = ITEMS.items, out = [];
    for (var id in ctx.procs.items) {
      var r = I[id];
      if (!r || !usable(r, cls, level)) continue;
      var P = ctx.procs.items[id], pv = procValue(P, ctx), sv = value(r, ctx.w);
      out.push({ id: +id, name: r[0], inv: r[1], tier: r[13] || "", src: r[14] || "source unknown", text: P.text, note: P.note,
                 kind: P.kind, pv: pv.v, how: pv.how, stats: sv, v: sv + pv.v });
    }
    return out.sort(function (a, b) { return b.pv - a.pv; });
  }

  var api = { parseExport: parseExport, bestInBags: bestInBags, value: value, bisList: bisList, extrasValues: extrasValues,
              procValue: procValue, procList: procList, cdModel: cdModel, setBonusValue: bonusValue, stOf: stOf, stAdd: stAdd };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ForeverBags = api;
})(this);
