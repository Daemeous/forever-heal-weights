// Forever healer stat weights - log parser and weight model.
// Runs in the browser (index.html) and in Node (tools/cli.js). No dependencies.
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ class defaults (all editable in the UI)
  // regen: mana per second per point of Spirit outside the five-second rule. Forever uses one formula for every
  //   class (not Classic's per-class ones): min(Spirit/4, 6.25 + Spirit/8) mana/sec, i.e. 0.125 per Spirit above 50.
  //   Fits every in-game reading: Priest 152/168/171 Spi = 126/136/138 MP5, Druid (lvl 27) 89/95 Spi = 86/90 MP5;
  //   the same formula was measured on a Paladin and a Shaman by the HealerStatWeights addon.
  //   casting: share of Spirit regen kept while casting (Meditation / Mindfulness / Reflection talents).
  //   sg: Spirit -> bonus healing (Priest Spiritual Guidance, 5% per point).
  //   intBonus: talent % on Intellect. critPerInt: % spell crit per Intellect point at level 60.
  var CLASS_DEFAULTS = {
    Priest:  { regen: 0.125, casting: 0.5, sg: 0, intBonus: 0, critPerInt: 0.0168 },
    Shaman:  { regen: 0.125, casting: 0.5, sg: 0, intBonus: 0, critPerInt: 0.0169 },
    Druid:   { regen: 0.125, casting: 0.5, sg: 0, intBonus: 0, critPerInt: 0.0167 },
    Paladin: { regen: 0.125, casting: 0,   sg: 0, intBonus: 0, critPerInt: 0.0167 },
  };
  var MANA_PER_INT = 15, RATING_PER_CRIT = 14;
  var REFUNDS = { "Litany of Light": 1 };                       // mana refunds tied to heal casts
  var CRIT_MANA = { "Water Shield": 1, "Illumination": 1 };    // mana that procs from (heal) crits
  var EXTRA_HEAL_CASTS = { "Power Word: Shield": 1 };          // heal-role casts that produce no heal event
  var ABSORBS = { "Power Word: Shield": 1, "Divine Aegis": 1 }; // absorbs credited to their caster as healing done
  var DOWNRANK_FULL = 17, DOWNRANK_PER = 0.05, DOWNRANK_FLOOR = 0.10;

  function downrank(learn) {
    var f = 1 - DOWNRANK_PER * (60 - learn - DOWNRANK_FULL);
    return Math.max(DOWNRANK_FLOOR, Math.min(1, f));
  }

  // ------------------------------------------------------------------ line parsing
  function splitFields(s) {
    if (s.indexOf('"') < 0) return s.split(",");
    var out = [], cur = "", q = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charCodeAt(i);
      if (ch === 34) { q = !q; continue; }
      if (ch === 44 && !q) { out.push(cur); cur = ""; continue; }
      cur += s[i];
    }
    out.push(cur);
    return out;
  }

  // "11/24/2026 20:27:02.1870" -> seconds (the timezone does not matter, only differences are used)
  function parseTime(h) {
    var sp = h.indexOf(" "), d = h.slice(0, sp).split("/"), t = h.slice(sp + 1).split(":");
    if (d.length !== 3 || t.length !== 3) return NaN;
    return Date.UTC(+d[2], +d[0] - 1, +d[1], +t[0], +t[1]) / 1000 + parseFloat(t[2]);
  }

  var WANT = {
    SPELL_HEAL: 1, SPELL_PERIODIC_HEAL: 1, SPELL_CAST_SUCCESS: 1, SPELL_ENERGIZE: 1, SPELL_PERIODIC_ENERGIZE: 1,
    ENCOUNTER_START: 1, ENCOUNTER_END: 1, UNIT_DIED: 1, SPELL_SUMMON: 1, COMBATANT_INFO: 1,
  };

  function newBucket(kind, label, start) {
    return {
      kind: kind, label: label, start: start, end: start, kill: null,
      heals: {},        // key sid|p|idx -> {n, nc, ncSum, okNC, okC, eff, over, crits}
      eff: 0, over: 0, critD: 0, nHeal: 0, nCrit: 0, spiritHeal: 0,
      casts: {},        // name|loggedCost -> count
      absorbs: {},      // absorb spell name -> amount (counted as healing done)
      energ: {},        // name -> [amount, count]
      tIn: 0, tOut: 0, drains: 0, full: false, minMana: 1, deaths: 0,
      active: 0, lastCast: null,   // seconds spent casting (gaps between casts, up to 5 sec each): the rate base for procs
    };
  }

  // talentTable (optional, docs/talents.js): lets the reader tell healing specs from off-specs as each fight starts
  function Analyzer(spellTable, talentTable) {
    this.S = spellTable.spells;
    this.TAL = talentTable || null;
    this.meta = spellTable.meta;
    this.players = {};        // guid -> player
    this.owner = {};          // pet/totem guid -> owner guid
    this.encounters = [];     // finished encounter buckets (shared index across players)
    this.enc = null;          // open encounter {idx, name, start}
    this.lines = 0; this.t0 = null; this.tLast = null;
  }

  // Each talent build a player logs is kept apart while reading (a "set"). At the end, the build that did most of the
  // player's class healing is their healing spec, and so is any other build with a healing-only talent (Spiritual
  // Healing, Gift of Nature, Purification, Healing Light, Improved Renew, ...). Everything else (e.g. Shadow) is
  // off-spec and left out of every total. healTalent: true / false, or null when it can't tell (no talent data).
  Analyzer.prototype.healTalent = function (talents) {
    var TAL = this.TAL;
    if (!TAL || !talents || !talents.length) return null;
    for (var i = 0; i < talents.length; i++) {
      var ti = TAL.entries[talents[i].entry];
      if (ti == null) continue;
      var T = TAL.talents[ti], r = T.r[Math.min(talents[i].rank, T.r.length) - 1] || {};
      // Twin Disciplines / Genesis boost damage too and turn up in damage specs, so they don't count
      if ((r.heal || []).some(function (h) { return !h.instant && !h.periodic; })) return true;
    }
    return false;
  };

  function sigOf(talents) {
    return (talents || []).map(function (x) { return x.entry + ":" + x.rank; }).sort().join(",");
  }

  Analyzer.prototype.useSet = function (p, talents) {
    var sig = sigOf(talents), S = p.sets[sig];
    if (!S) S = p.sets[sig] = { sig: sig, healTal: this.healTalent(talents),
      all: newBucket("all", "Whole log", this.tLast), trash: newBucket("trash", "Trash and between pulls", this.tLast), enc: {} };
    p.cur = S;
    p.all = S.all; p.trash = S.trash; p.enc = S.enc;    // provisional until finish() picks the healing spec
  };

  Analyzer.prototype.player = function (guid, name) {
    var p = this.players[guid];
    if (!p) {
      p = this.players[guid] = {
        guid: guid, name: name || guid, cls: {}, info: null,
        sets: {}, cur: null, all: null, trash: null, enc: null,
        chain: {},           // sid -> open chain group
        last: null, lastSpend: null, dead: false, pend: null, drops: {}, infos: [], hl: [], hlB: [], hlK: [], critMult: 1.5,
        offEnc: {}, healSigs: null, maxSeen: {},
      };
      this.useSet(p, null);
    }
    if (name && p.name === guid) p.name = name;
    if (p.infos.length === 0 && this.pendingInfo && this.pendingInfo[guid]) {
      p.infos = this.pendingInfo[guid]; delete this.pendingInfo[guid];
      p.info = p.infos[p.infos.length - 1].stats; this.useSet(p, p.infos[p.infos.length - 1].talents);
    }
    return p;
  };

  Analyzer.prototype.buckets = function (p, t) {
    var S = p.cur, b = [S.all];
    if (this.enc) {
      var e = S.enc[this.enc.idx];
      if (!e) e = S.enc[this.enc.idx] = newBucket("enc", this.enc.name, this.enc.start);
      e.encIdx = this.enc.idx;
      b.push(e);
    } else b.push(S.trash);
    for (var i = 0; i < b.length; i++) { if (b[i].start == null) b[i].start = t; b[i].end = t; }
    return b;
  };

  // Raw combat log line -> normalised event (the same shape the Warcraft Logs adapter produces, see wcl.js):
  // {t, type: encStart|encEnd|info|summon|death|heal|cast|energize|other, src, srcName, dst, sid, spell,
  //  periodic, amount (incl. overheal), over, crit, hp, maxHp (target after the heal), cost (as logged),
  //  adv: {unit, mana, max} (a mana reading of a unit), ptype, kill, stats}
  Analyzer.prototype.line = function (line) {
    var sp = line.indexOf("  ");
    if (sp < 0) return;
    var body = line.slice(sp + 2), c = body.indexOf(",");
    var ev = body.slice(0, c);
    var isSpell = ev.charCodeAt(0) === 83 && ev.charCodeAt(1) === 80;   // "SP..."
    if (!WANT[ev] && !isSpell) return;
    var t = parseTime(line.slice(0, sp));
    if (isNaN(t)) return;
    var f = splitFields(body.slice(c + 1).replace(/\s+$/, ""));
    var E = { t: t, type: "other", src: f[0], srcName: f[1], dst: f[4], sid: f[8], spell: f[9] };
    if (ev === "ENCOUNTER_START") { E.type = "encStart"; E.name = f[1]; }
    else if (ev === "ENCOUNTER_END") { E.type = "encEnd"; E.kill = f[4] === "1"; }
    else if (ev === "COMBATANT_INFO") {
      E.type = "info"; E.stats = { str: +f[2], agi: +f[3], sta: +f[4], int: +f[5], spi: +f[6] };
      var tl = body.match(/\[(\(\d+,\d+,\d+\)(?:,\(\d+,\d+,\d+\))*)\]/);   // talents: (node, entry, rank)
      E.talents = tl ? tl[1].slice(1, -1).split("),(").map(function (x) { var v = x.split(","); return { entry: v[1], rank: +v[2] }; }) : [];
    }
    else if (ev === "SPELL_SUMMON") E.type = "summon";
    else if (ev === "UNIT_DIED") E.type = "death";
    else if (ev === "SPELL_HEAL" || ev === "SPELL_PERIODIC_HEAL") {
      if (f.length <= 34) return;
      E.type = "heal"; E.periodic = ev === "SPELL_PERIODIC_HEAL";
      E.amount = +f[30]; E.over = +f[32]; E.crit = f[34] === "1"; E.hp = +f[13]; E.maxHp = +f[14];
    } else if (ev === "SPELL_CAST_SUCCESS") { E.type = "cast"; E.cost = +f[24] || 0; }
    else if (ev === "SPELL_ABSORBED") {   // ..., caster GUID, name, flags, raid flags, absorb spell id, name, school, amount
      for (var ai = 8; ai + 7 < f.length; ai++) {
        if (ABSORBS[f[ai + 5]] && f[ai].indexOf("Player-") === 0) {
          E = { t: t, type: "absorb", src: f[ai], srcName: f[ai + 1], dst: f[4], sid: f[ai + 4], spell: f[ai + 5], amount: +f[ai + 7] || 0 };
          break;
        }
      }
      if (E.type !== "absorb") return;
    }
    else if (ev === "SPELL_ENERGIZE" || ev === "SPELL_PERIODIC_ENERGIZE") {
      E.type = "energize"; E.amount = +f[30] || 0; E.over = +f[31] || 0; E.ptype = f[32];
    }
    if (f.length > 24 && f[21] === "0") E.adv = { unit: f[11], mana: +f[22], max: +f[23] };
    this.event(E);
  };

  Analyzer.prototype.event = function (E) {
    var t = E.t;
    this.lines++;
    if (this.t0 == null) this.t0 = t;
    this.tLast = t;
    if (E.type === "encStart") { this.closeEncounter(t, null); this.enc = { idx: this.encounters.length, name: E.name, start: t }; this.encounters.push({ name: E.name, start: t, end: t, kill: null }); return; }
    if (E.type === "encEnd") { this.closeEncounter(t, E.kill); return; }
    if (E.type === "info") {   // several per log (one per pull): keep them all, detect() picks the healing spec
      var rec = { t: t, stats: E.stats, talents: E.talents || [] };
      var pi = this.players[E.src];
      if (pi) { pi.info = E.stats; pi.infos.push(rec); if (rec.talents.length) this.useSet(pi, rec.talents); }
      else ((this.pendingInfo = this.pendingInfo || {})[E.src] = this.pendingInfo[E.src] || []).push(rec);
      return;
    }
    if (E.type === "summon") { if (E.src.indexOf("Player-") === 0) this.owner[E.dst] = E.src; return; }
    if (E.type === "death") {
      var pd = this.players[E.dst];
      if (pd) { pd.dead = true; pd.last = null; var bd = this.buckets(pd, t); for (var i = 0; i < bd.length; i++) bd[i].deaths++; }
      return;
    }
    if (E.type === "absorb") {
      if (!ABSORBS[E.spell] || E.src.indexOf("Player-") !== 0) return;
      var pa = this.player(E.src, E.srcName), ba = this.buckets(pa, t);
      for (var k = 0; k < ba.length; k++) ba[k].absorbs[E.spell] = (ba[k].absorbs[E.spell] || 0) + E.amount;
      return;
    }
    var src = E.src, A = E.adv, adv = A ? this.players[A.unit] : null;
    if (E.type === "heal") {
      var who = src.indexOf("Player-") === 0 ? src : this.owner[src];
      if (who) this.heal(who, src === who ? E.srcName : null, E);
    } else if (E.type === "cast") {
      if (src.indexOf("Player-") === 0 && A && A.unit === src) this.cast(this.player(src, E.srcName), E);
    } else if (E.type === "energize") {
      var pe = this.players[E.dst];
      if (pe && E.ptype === "0") {
        var amt = E.amount - E.over, be = this.buckets(pe, t);
        for (var j = 0; j < be.length; j++) { var x = be[j].energ[E.spell] || (be[j].energ[E.spell] = [0, 0]); x[0] += amt; x[1]++; }
      }
    }
    if (adv && !(E.type === "cast" && src === A.unit)) this.reading(adv, t, A.mana, A.max, false);
  };

  Analyzer.prototype.heal = function (guid, name, E) {
    var p = this.player(guid, name), t = E.t;
    var s = this.S[E.sid];
    if (s) p.cls[s.c] = (p.cls[s.c] || 0) + 1;
    var h = { sid: E.sid, name: E.spell, p: E.periodic ? 1 : 0, a: E.amount, o: E.over, crit: E.crit,
              hp: E.hp, max: E.maxHp, b: this.buckets(p, t), t: t, idx: 0 };
    var chain = s && !E.periodic && s.d && s.d.length > 2;
    if (chain) {                                   // Chain Heal: group hits, the log lists the smallest jump first
      var g = p.chain[h.sid];
      if (g && t - g[0].t < 0.5 && g.length < 3) { g.push(h); return; }
      if (g) this.flushChain(p, g);
      p.chain[h.sid] = [h];
      return;
    }
    this.addHeal(p, h);
  };

  Analyzer.prototype.flushChain = function (p, g) {
    g.sort(function (x, y) { return y.a / (y.crit ? 1.5 : 1) - x.a / (x.crit ? 1.5 : 1); });
    for (var i = 0; i < g.length; i++) { g[i].idx = i; this.addHeal(p, g[i]); }
  };

  Analyzer.prototype.addHeal = function (p, h) {
    var key = h.sid + "|" + h.p + "|" + h.idx;
    // the value of +crit for this heal depends on how big this healer's crits are (x1.5, more with talents such as
    // Holy Power), which is only known at the end: keep what it needs and work it out in finish()
    p.hl.push(h.a, h.o, h.crit ? 1 : 0, h.max > 0 ? Math.max(0, h.max - h.hp) : -1);
    p.hlB.push(h.b); p.hlK.push(key);
    for (var i = 0; i < h.b.length; i++) {
      var b = h.b[i], r = b.heals[key];
      if (!r) r = b.heals[key] = { sid: h.sid, name: h.name, p: h.p, idx: h.idx, n: 0, nc: 0, ncSum: 0, cSum: 0, okNC: 0, okC: 0, eff: 0, over: 0, crits: 0, critD: 0 };
      r.n++; r.eff += h.a - h.o; r.over += h.o;
      if (h.crit) { r.crits++; r.cSum += h.a; if (h.o === 0) r.okC++; }
      else { r.nc++; r.ncSum += h.a; if (h.o === 0) r.okNC++; }
      b.eff += h.a - h.o; b.over += h.o; b.nHeal++; if (h.crit) b.nCrit++;
    }
  };

  Analyzer.prototype.cast = function (p, E) {
    var t = E.t, cost = E.cost || 0, m = E.adv.mana, x = E.adv.max;
    p.dead = false;
    var b = this.buckets(p, t), key = E.spell + "|" + cost;
    for (var i = 0; i < b.length; i++) {
      b[i].casts[key] = (b[i].casts[key] || 0) + 1;
      b[i].active += b[i].lastCast != null ? Math.max(0, Math.min(5, t - b[i].lastCast)) : 1.5;
      b[i].lastCast = t;
    }
    this.reading(p, t, m, x, true);
    if (cost > 0) { p.lastSpend = t; p.pend = { t: t, key: key, m: m }; }
    // drains: whole log = full (>=95%) -> nearly empty (<=10%) cycles; encounter / trash = ever <=10%
    var r = x > 0 ? m / x : 1;
    for (i = 0; i < b.length; i++) {
      if (b[i].kind !== "enc") { if (r >= 0.95) b[i].full = true; else if (b[i].full && r <= 0.10) { b[i].drains++; b[i].full = false; } }
      else if (r <= 0.10 && !b[i].drained) { b[i].drains = 1; b[i].drained = true; }
    }
  };

  Analyzer.prototype.reading = function (p, t, m, x, isCast) {
    if (!(x > 0)) return;
    // the cast event shows mana BEFORE the cost; the next reading within 0.3 s shows what it really cost
    if (!isCast && p.pend && t - p.pend.t < 0.3) {
      var d = Math.round(p.pend.m - m), dr = p.drops[p.pend.key] || (p.drops[p.pend.key] = {});
      dr[d] = (dr[d] || 0) + 1;
      p.pend = null;
    }
    var b = this.buckets(p, t);
    p.maxSeen[x] = (p.maxSeen[x] || 0) + 1;
    for (var i = 0; i < b.length; i++) if (m / x < b[i].minMana) b[i].minMana = m / x;
    var L = p.last;
    p.last = { t: t, m: m, x: x };
    if (!L || p.dead) return;
    var dt = t - L.t;
    if (L.m >= L.x || dt <= 0) return;
    var inside = p.lastSpend != null ? Math.max(0, Math.min(dt, p.lastSpend + 5 - L.t)) : 0;
    for (i = 0; i < b.length; i++) {
      if (dt > (b[i].kind === "enc" ? 20 : 120)) continue;
      b[i].tIn += inside; b[i].tOut += dt - inside;
    }
  };

  Analyzer.prototype.closeEncounter = function (t, kill) {
    if (!this.enc) return;
    var e = this.encounters[this.enc.idx];
    e.end = t; e.kill = kill;
    for (var g in this.players) {
      var sets = this.players[g].sets;
      for (var sg in sets) {
        var b = sets[sg].enc[this.enc.idx];
        if (b) { b.end = t; b.kill = kill; b.start = this.enc.start; }
      }
    }
    this.enc = null;
  };

  Analyzer.prototype.finish = function () {
    this.closeEncounter(this.tLast, null);
    for (var g in this.players) {
      var p = this.players[g];
      for (var sid in p.chain) this.flushChain(p, p.chain[sid]);
      p.chain = {};
      // which talent builds are healing specs (see useSet)
      var Sx = this.S, sets = Object.keys(p.sets).map(function (k) { return p.sets[k]; }), main = null, mainHeal = -1;
      sets.forEach(function (st) {
        st.classHeal = 0;
        for (var k in st.all.heals) if (Sx[st.all.heals[k].sid]) st.classHeal += st.all.heals[k].eff;
        if (st.classHeal > mainHeal) { mainHeal = st.classHeal; main = st; }
      });
      var healing = sets.filter(function (st) { return st === main || st.healTal !== false; });
      p.healSigs = {};
      healing.forEach(function (st) { p.healSigs[st.sig] = true; });
      p.critMult = critMultiplier(healing.map(function (st) { return st.all.heals; }));
      var m = p.critMult, H = p.hl;
      for (var q = 0, hb = 0; q < H.length; q += 4, hb++) {
        var a = H[q], o = H[q + 1], c = H[q + 2], miss = H[q + 3], cd = 0;
        if (c) cd = o === 0 ? a * (m - 1) / m : Math.max(0, (a - o) - a / m);
        else if (o === 0 && miss >= 0) cd = Math.min((m - 1) * a, miss);
        if (cd) p.hlB[hb].forEach(function (bk) { bk.critD += cd; var hr = bk.heals[p.hlK[hb]]; if (hr) hr.critD += cd; });
      }
      p.hl = []; p.hlB = []; p.hlK = [];
      // the healing-spec totals; fights played only in an off-spec are just noted
      if (healing.length === 1) { p.all = healing[0].all; p.trash = healing[0].trash; p.enc = healing[0].enc; }
      else {
        p.all = newBucket("all", "Whole log", null); p.trash = newBucket("trash", "Trash and between pulls", null); p.enc = {};
        healing.forEach(function (st) {
          mergeInto(p.all, st.all); mergeInto(p.trash, st.trash);
          for (var i in st.enc) {
            if (!p.enc[i]) { p.enc[i] = newBucket("enc", st.enc[i].label, st.enc[i].start); p.enc[i].encIdx = +i; p.enc[i].kill = st.enc[i].kill; }
            mergeInto(p.enc[i], st.enc[i]);
          }
        });
      }
      p.offEnc = {};
      sets.forEach(function (st) { if (!p.healSigs[st.sig]) for (var i in st.enc) if (!p.enc[i]) p.offEnc[i] = true; });
      if (this.pendingInfo && this.pendingInfo[g]) { p.infos = this.pendingInfo[g].concat(p.infos); if (!p.info) p.info = p.infos[p.infos.length - 1].stats; }
      // measured real cost per spell|logged cost (the log shows the pre-talent base cost): the median of the drops
      // clustered around the most common one (regen ticks and refunds landing in between spread them a little)
      p.realCost = {};
      for (var k in p.drops) {
        var dk = p.drops[k], best = null, tot = 0, logged = +k.split("|").pop();
        for (var d in dk) { tot += dk[d]; if (+d > 0 && (best == null || dk[d] > dk[best])) best = d; }
        if (best == null) continue;
        var tol = Math.max(3, 0.04 * best), cl = [];
        for (d in dk) if (Math.abs(d - best) <= tol) cl.push([+d, dk[d]]);
        cl.sort(function (a, b) { return a[0] - b[0]; });
        var cn = cl.reduce(function (s, x) { return s + x[1]; }, 0), half = cn / 2, acc = 0, med = +best;
        for (var j = 0; j < cl.length; j++) { acc += cl[j][1]; if (acc >= half) { med = cl[j][0]; break; } }
        if (cn >= 3 && cn >= 0.3 * tot && med <= logged * 1.05) p.realCost[k] = Math.min(med, logged);
      }
      var best2 = null, bc = 0;
      for (var c in p.cls) if (p.cls[c] > bc) { bc = p.cls[c]; best2 = c; }
      p.mainClass = best2;
    }
    return this;
  };

  // crit size: mean crit / mean non-crit over this healer's spells (weighted median); 1.5 when the log can't tell
  function critMultiplier(healMaps) {
    var xs = [], tot = {};
    healMaps.forEach(function (hm) {
      for (var k in hm) {
        var r = hm[k], t = tot[k] || (tot[k] = { crits: 0, cSum: 0, nc: 0, ncSum: 0 });
        t.crits += r.crits; t.cSum += r.cSum; t.nc += r.nc; t.ncSum += r.ncSum;
      }
    });
    for (var k in tot) {
      var r = tot[k];
      if (r.crits >= 5 && r.nc >= 10) xs.push([(r.cSum / r.crits) / (r.ncSum / r.nc), Math.min(r.crits, r.nc)]);
    }
    if (!xs.length) return 1.5;
    xs.sort(function (a, b) { return a[0] - b[0]; });
    var W = xs.reduce(function (t, x) { return t + x[1]; }, 0), acc = 0;
    for (var i = 0; i < xs.length; i++) { acc += xs[i][1]; if (acc >= W / 2) return Math.max(1.2, Math.min(2.5, xs[i][0])); }
    return 1.5;
  }

  // ------------------------------------------------------------------ the model
  // d(heal)/d(bonus healing) for one heal record, from the client coefficient and the empirical talent multiplier
  // (mean non-crit heal / (base + coefficient x downrank x B)), measured over the whole log for that spell / jump.
  function perPoint(S, allRec, B, m) {
    var s = S[allRec.sid];
    if (!s || s.spirit) return 0;
    var e = allRec.p ? (s.h || s.d) : (s.d || s.h), lv = s.l;
    if (s.like && S[s.like]) { var L = S[s.like]; e = L.h || L.d; lv = L.l; }   // heals for another spell's amount (Swiftmend)
    if (!e || !(e[1] > 0)) return 0;
    var coef = e[1] * downrank(lv), base = e[0];
    var mean = allRec.nc > 0 ? allRec.ncSum / allRec.nc : (allRec.crits > 0 ? allRec.cSum / allRec.crits / (m || 1.5) : 0);
    var denom = base + coef * B;
    if (!(denom > 0) || !(mean > 0)) return 0;
    return coef * mean / denom;
  }

  function evaluate(an, p, bucket, opt, lamRef) {
    var S = an.S, B = opt.bonus;
    var healD = 0, m = p.critMult || 1.5, spiritHeal = 0, spells = {}, healEff = 0, healOver = 0;
    function sp(n) { return spells[n] || (spells[n] = { name: n, casts: 0, mana: 0, eff: 0, over: 0, hits: 0, crits: 0, absorb: 0, critD: 0 }); }
    for (var key in bucket.heals) {
      var r = bucket.heals[key], ref = p.all.heals[key] || r, sd = S[r.sid];
      healD += perPoint(S, ref, B, m) * (r.okNC + m * r.okC);
      if (sd && sd.spirit) spiritHeal += r.okNC + m * r.okC;      // Bloom: heals for the Druid's Spirit
      if (!sd) continue;                                           // potions, trinkets, other players' procs
      healEff += r.eff; healOver += r.over;
      var x = sp(r.name); x.eff += r.eff; x.over += r.over; x.hits += r.n; x.crits += r.crits; x.critD += r.critD || 0;
    }
    var absorbed = 0;
    for (var abn in bucket.absorbs) { absorbed += bucket.absorbs[abn]; sp(abn).absorb += bucket.absorbs[abn]; sp(abn).eff += bucket.absorbs[abn]; }
    var spent = 0, spentHeal = 0, castsByName = {}, nCasts = 0, healCasts = 0;
    for (var ck in bucket.casts) {
      var nm = ck.slice(0, ck.lastIndexOf("|")), logged = +ck.slice(ck.lastIndexOf("|") + 1);
      var real = p.realCost[ck] != null ? p.realCost[ck] : logged;
      var mc = real * bucket.casts[ck];
      spent += mc; castsByName[nm] = (castsByName[nm] || 0) + bucket.casts[ck]; nCasts += bucket.casts[ck];
      if (EXTRA_HEAL_CASTS[nm] || hasHealName(p, nm)) { spentHeal += mc; healCasts += bucket.casts[ck]; var y = sp(nm); y.casts += bucket.casts[ck]; y.mana += mc; }
    }
    var refund = 0, critProcs = 0, critMana = 0;
    for (var en in bucket.energ) {
      if (REFUNDS[en]) refund += bucket.energ[en][0];
      if (CRIT_MANA[en]) { critProcs += bucket.energ[en][1]; critMana += bucket.energ[en][0]; }
    }
    spent -= refund; spentHeal -= refund;
    var eff = healEff + absorbed, hpm = spentHeal > 0 ? eff / spentHeal : 0;
    var critRate = bucket.nHeal ? bucket.nCrit / bucket.nHeal : 0;
    var ib = 1 + opt.intBonus / 100;
    function weights(lam) {
      var wCrit = bucket.critD / 100;
      if (critRate > 0 && critProcs) wCrit += lam * critMana / (critRate * 100);
      var manaInt = MANA_PER_INT * ib * bucket.drains;
      if (bucket.energ["Water Shield"]) manaInt += MANA_PER_INT * ib * 0.02 * bucket.energ["Water Shield"][1];
      var w = {
        healing: healD,
        critRating: wCrit / RATING_PER_CRIT,
        intellect: wCrit * opt.critPerInt * ib + (opt.intHeal || 0) / 100 * ib * healD + lam * manaInt,
        spirit: (1 + (opt.spiBonus || 0) / 100) * (opt.sg / 100 * healD + spiritHeal + lam * opt.regen * (bucket.tOut + opt.casting / 100 * bucket.tIn)),
        mp5: lam * 0.2 * (bucket.tIn + bucket.tOut),
        critPct: wCrit,
      };
      var n = {};
      for (var k in w) n[k] = healD > 0 ? w[k] / healD : 0;
      return n;
    }
    return {
      label: bucket.label, kind: bucket.kind, kill: bucket.kill, start: bucket.start, end: bucket.end,
      duration: Math.max(0, (bucket.end || 0) - (bucket.start || 0)),
      eff: eff, over: healOver, overPct: eff + healOver > 0 ? healOver / (eff + healOver) : 0,
      spent: spent, spentHeal: spentHeal, refund: refund, hpm: hpm, critRate: critRate, minMana: bucket.minMana,
      tIn: bucket.tIn, tOut: bucket.tOut, drains: bucket.drains, deaths: bucket.deaths,
      healPerPoint: healD, absorbed: absorbed, critMult: m,
      // what proc / on-use estimates need: rates per second of casting ("active"), casts by spell name
      rates: { active: bucket.active || 0, casts: castsByName, nCasts: nCasts, healCasts: healCasts, critD: bucket.critD },
      raw: { critD: bucket.critD, critMana: critMana, critProcs: critProcs, spiritHeal: spiritHeal,
             wsProcs: bucket.energ["Water Shield"] ? bucket.energ["Water Shield"][1] : 0 },
      spells: Object.keys(spells).map(function (k) { return spells[k]; }).filter(function (x) { return x.eff + x.over > 0 || x.casts; })
        .sort(function (a, b) { return b.eff - a.eff; }),
      throughput: weights(0), manaLimited: weights(lamRef != null ? lamRef : hpm), lambda: lamRef != null ? lamRef : hpm,
      healing: healD > 0,
    };
  }

  // ------------------------------------------------------------------ boss fight of a set length (estimate)
  // The 'BiS lists' sheet's fight model. A mana-limited fight of L seconds funds
  //   M = max mana + L x regen + potions / other mana,  regen = Spirit regen x (outside 5SR + casting share x inside)
  //   + gear MP5 / 5, and total healing ~ M x healing per mana, so +1 mana is worth k / M (+1 healing), with
  //   k = healing / (healing per +1 bonus healing) x mana spent / mana spent on heals, all from the logged boss fights.
  // Crit keeps its logged value plus its mana (Water Shield / Illumination, scaled with the fight's mana); Intellect =
  // 15 mana + its crit (+ bigger Water Shield globes); Spirit / MP5 = their regen over L. Throughput = the logged one.
  function spiritRegen(spi) { return Math.min(spi / 4, 6.25 + spi / 8); }   // mana/sec, every class (see CLASS_DEFAULTS)

  function fightModel(base, opt, L, fm) {
    var R = base.raw, hd = base.healPerPoint, tt = base.tIn + base.tOut;
    if (!(hd > 0) || !(base.spentHeal > 0) || !(base.spent > 0)) return null;
    var out = tt > 0 ? base.tOut / tt : 1, c = opt.casting / 100, share = out + c * (1 - out);
    var regen = spiritRegen(fm.spirit) * share + (fm.mp5 || 0) / 5;
    var M = fm.maxMana + L * regen + (fm.other || 0);
    var k = base.eff / hd * base.spent / base.spentHeal, lam = M > 0 ? k / M : 0;
    var critPct = R.critD / (100 * hd);
    if (base.critRate > 0 && R.critProcs) critPct += R.critMana / (base.critRate * 100) / base.spent * k;
    var ib = 1 + opt.intBonus / 100;
    var pace = tt > 0 ? base.spent / tt : 0, need = pace * L;
    var w = {
      healing: 1,
      critRating: critPct / RATING_PER_CRIT,
      intellect: ib * (MANA_PER_INT * lam + opt.critPerInt * critPct + (opt.intHeal || 0) / 100 +
                       (R.wsProcs ? MANA_PER_INT * 0.02 * R.wsProcs / base.spent * k : 0)),
      spirit: (1 + (opt.spiBonus || 0) / 100) * (opt.sg / 100 + R.spiritHeal / hd + opt.regen * L * share * lam),
      mp5: L / 5 * lam,
      critPct: critPct,
    };
    return { label: "Boss fight, " + (L % 60 ? L + " sec" : L / 60 + " min") + " (estimate)", kind: "model", seconds: L,
             duration: L, healing: true, mana: M, regen: regen, need: need, funded: need > 0 ? M / need : 1, lambda: lam,
             manaLimited: w, throughput: base.throughput, healPerPoint: hd * L / Math.max(1, base.duration), eff: base.eff, hpm: base.hpm,
             overPct: base.overPct, minMana: base.minMana, spells: base.spells, rates: base.rates, base: base };
  }

  // the fight model's log-side inputs for a player: most common max mana reading, Spirit from COMBATANT_INFO
  function fightInputs(an, guid) {
    var p = an.players[guid], best = 0, bn = 0;
    for (var x in p.maxSeen) if (p.maxSeen[x] > bn) { bn = p.maxSeen[x]; best = +x; }
    return { maxMana: best, spirit: p.info ? p.info.spi : 0 };
  }

  function hasHealName(p, nm) {
    if (!p._healNames) { p._healNames = {}; for (var k in p.all.heals) p._healNames[p.all.heals[k].name] = 1; }
    return !!p._healNames[nm];
  }

  // healers worth showing: players with a meaningful amount of class-spell healing, best first
  function healers(an) {
    var out = [];
    for (var g in an.players) {
      var p = an.players[g];
      if (!p.mainClass || g.indexOf("Player-") !== 0) continue;
      var classHeal = 0;
      for (var k in p.all.heals) if (an.S[p.all.heals[k].sid]) classHeal += p.all.heals[k].eff;
      if (classHeal < 5000) continue;
      out.push({ guid: g, name: p.name, cls: p.mainClass, eff: classHeal });
    }
    return out.sort(function (a, b) { return b.eff - a.eff; });
  }

  function analyse(an, guid, opt) {
    var p = an.players[guid], encs = [];
    var bosses = newBucket("bosses", "All boss fights", null);
    for (var i = 0; i < an.encounters.length; i++) {
      var b = p.enc[i];
      if (!b || (b.eff <= 0 && !Object.keys(b.casts).length)) continue;
      b.label = an.encounters[i].name; b.kill = an.encounters[i].kill;
      b.start = an.encounters[i].start; b.end = an.encounters[i].end;
      encs.push(b);
      merge(bosses, b);
    }
    var whole = evaluate(an, p, p.all, opt);
    var bossRow = encs.length ? evaluate(an, p, bosses, opt) : null;
    var bossDur = encs.reduce(function (s, b) { return s + (b.end - b.start); }, 0);
    // one steady value of mana for every fight: per-fight healing per mana is meaningless (a 30 sec fight is mostly
    // healed by HoTs / Prayer of Mending cast before the pull), so use the boss-fight (else whole-log) figure
    var lam = bossRow && bossRow.spentHeal > 2000 ? bossRow.hpm : whole.hpm;
    if (opt.lambda > 0) lam = opt.lambda;
    return {
      player: { guid: guid, name: p.name, cls: p.mainClass, info: p.info },
      lambda: lam,
      whole: evaluate(an, p, p.all, opt, lam),
      bosses: bossRow ? Object.assign(evaluate(an, p, bosses, opt, lam), { duration: bossDur }) : null,
      trash: evaluate(an, p, p.trash, opt, lam),
      encounters: encs.map(function (b) { var r = evaluate(an, p, b, opt, lam); r.lowMana = b.minMana <= 0.2; return r; })
        .concat(Object.keys(p.offEnc).filter(function (i) { return !p.enc[i]; }).map(function (i) {
          var e = an.encounters[i];
          return { label: e.name, kill: e.kill, start: e.start, end: e.end, duration: e.end - e.start, offspec: true, healing: false,
                   eff: 0, over: 0, overPct: 0, minMana: 1, hpm: 0 };
        })).sort(function (a, b) { return a.start - b.start; }),
      realCost: p.realCost,
    };
  }

  // estimates for boss fights of set lengths, from the boss-fight figures (whole log when there are none)
  function fights(res, opt, list) {
    var base = res.bosses && res.bosses.spentHeal > 2000 ? res.bosses : res.whole;
    return list.map(function (f) { return fightModel(base, opt, f.seconds, f); }).filter(Boolean);
  }

  function mergeInto(into, b) {
    merge(into, b);
    if (b.start != null && (into.start == null || b.start < into.start)) into.start = b.start;
    if (b.end != null && (into.end == null || b.end > into.end)) into.end = b.end;
  }

  function merge(into, b) {
    ["eff", "over", "critD", "nHeal", "nCrit", "spiritHeal", "tIn", "tOut", "drains", "deaths", "active"].forEach(function (k) { into[k] += b[k] || 0; });
    into.minMana = Math.min(into.minMana, b.minMana);
    for (var k in b.heals) {
      var r = b.heals[k], s = into.heals[k];
      if (!s) { into.heals[k] = JSON.parse(JSON.stringify(r)); continue; }
      ["n", "nc", "ncSum", "cSum", "okNC", "okC", "eff", "over", "crits", "critD"].forEach(function (f) { s[f] += r[f] || 0; });
    }
    for (var c in b.casts) into.casts[c] = (into.casts[c] || 0) + b.casts[c];
    for (var ab in b.absorbs) into.absorbs[ab] = (into.absorbs[ab] || 0) + b.absorbs[ab];
    for (var e in b.energ) { var x = into.energ[e] || (into.energ[e] = [0, 0]); x[0] += b.energ[e][0]; x[1] += b.energ[e][1]; }
  }

  function defaults(cls) {
    var d = CLASS_DEFAULTS[cls] || CLASS_DEFAULTS.Priest;
    return { bonus: 500, regen: d.regen, casting: d.casting * 100, sg: d.sg, intBonus: d.intBonus, critPerInt: d.critPerInt, lambda: 0,
             spiBonus: 0, intHeal: 0 };
  }

  // ------------------------------------------------------------------ inputs from the log itself
  // Talents (COMBATANT_INFO) give Int %, Spirit %, Spirit -> healing, Int -> healing, regen while casting and the
  // healing multipliers; with those, each heal spell's average non-crit heal gives an estimate of bonus healing:
  //   mean = T x (base + coefficient x B)  ->  B = (mean / T - base) / coefficient
  // T = (1 + class-wide % (all heals / instant / HoT ticks), added) x (1 + spell-specific %) - the workbook convention.
  function detect(an, guid, TAL) {
    var p = an.players[guid], out = { talents: [], inputs: {}, bonus: null };
    if (!p || !TAL) return out;
    // the talent set to use: the logged spec with the most known healer talents (logs can include an off-spec)
    var best = null, bestN = -1;
    (p.infos || []).forEach(function (inf) {
      if (p.healSigs && inf.talents.length && !p.healSigs[sigOf(inf.talents)]) return;     // off-spec build
      var n = inf.talents.filter(function (x) { return TAL.entries[x.entry] != null; }).length;
      if (n >= bestN) { best = inf; bestN = n; }
    });
    if (!best) return out;
    var gen = { all: 0, instant: 0, periodic: 0 }, spec = {};
    var v = { int: 0, spi: 0, sg: 0, intHeal: 0, casting: 0 };
    best.talents.forEach(function (x) {
      var ti = TAL.entries[x.entry];
      if (ti == null) return;
      var T = TAL.talents[ti], r = T.r[Math.min(x.rank, T.r.length) - 1] || {};
      out.talents.push({ name: T.n, rank: x.rank, max: T.r.length, fx: r });
      if (r.int) v.int += r.int;
      if (r.spi) v.spi += r.spi;
      if (r.sg) v.sg += r.sg;
      if (r.intHeal) v.intHeal += r.intHeal;
      if (r.casting) v.casting = Math.max(v.casting, r.casting);
      (r.heal || []).forEach(function (h) {
        if (h.spells) h.spells.forEach(function (n) { n = n.toLowerCase(); spec[n] = (spec[n] || 0) + h.pct; });
        else for (var k in gen) if (h[k]) gen[k] += h.pct;
      });
    });
    out.stats = best.stats;
    out.inputs = { intBonus: v.int, spiBonus: v.spi, sg: v.sg, intHeal: v.intHeal, casting: v.casting };
    // bonus healing: per spell (first target only, full-coefficient ranks, enough non-crit samples)
    var est = [];
    for (var k in p.all.heals) {
      var r = p.all.heals[k], s = an.S[r.sid];
      if (!s || s.spirit || r.idx !== 0 || r.nc < 15 || downrank(s.l) < 1) continue;
      var e = r.p ? (s.h || s.d) : (s.d || s.h);
      if (!e || !(e[1] > 0.05)) continue;
      var nm = s.n.toLowerCase();
      if (nm === "holy binding" || nm === "healing stream") continue;
      var T = (1 + (gen.all + (s.i ? gen.instant : 0) + (r.p ? gen.periodic : 0)) / 100) * (1 + (spec[nm] || 0) / 100);
      var B = (r.ncSum / r.nc / T - e[0]) / e[1];
      est.push({ spell: s.n + (r.p && s.d ? " (HoT)" : ""), B: B, n: r.nc, w: r.nc * e[1] });
    }
    if (est.length) {
      est.sort(function (a, b) { return a.B - b.B; });
      var W = est.reduce(function (t, x) { return t + x.w; }, 0), acc = 0, med = est[0].B;
      for (var i = 0; i < est.length; i++) { acc += est[i].w; if (acc >= W / 2) { med = est[i].B; break; } }
      out.bonus = { value: Math.round(med), spells: est, lo: Math.round(est[0].B), hi: Math.round(est[est.length - 1].B) };
    }
    return out;
  }

  var api = { detect: detect, fights: fights, fightInputs: fightInputs, spiritRegen: spiritRegen, Analyzer: Analyzer, analyse: analyse, healers: healers, defaults: defaults, downrank: downrank,
              CLASS_DEFAULTS: CLASS_DEFAULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ForeverWeights = api;
})(this);
