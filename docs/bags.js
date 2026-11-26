// Best in bags: reads a MythicSim / voidsim.io Forever export (or anything with {"id": ...} items in it), and picks the
// best gear the character owns for the stat weights the page worked out. Runs in the browser and in Node.
(function (root) {
  "use strict";
  // item table row: [name, invType, itemClass, subclass, reqLevel, quality, heal, crit, int, spi, mp5, classMask, unique]
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

  function value(row, w) {
    if (!row) return 0;
    return w.healing * row[6] + w.critRating * row[7] + w.intellect * row[8] + w.spirit * row[9] + w.mp5 * row[10];
  }

  // w: weights relative to +1 healing ({healing, critRating, intellect, spirit, mp5})
  function bestInBags(exp, cls, level, w, ITEMS) {
    var I = ITEMS.items, unknown = 0, counts = {};
    exp.owned.forEach(function (id) { counts[id] = (counts[id] || 0) + 1; if (!I[id]) unknown++; });
    var pool = Object.keys(counts).filter(function (id) { return usable(I[id], cls, level); })
      .map(function (id) { var r = I[id]; return { id: +id, name: r[0], inv: r[1], copies: counts[id], unique: r[12], v: value(r, w), row: r }; });
    var eq = exp.equipped.filter(function (id) { return I[id]; })
      .map(function (id) { var r = I[id]; return { id: id, name: r[0], inv: r[1], v: value(r, w), row: r }; });
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
    var rows = [];
    SLOTS.forEach(function (s) {
      var n = s[2] || 1, best = top(s[1], n), cur = worn(s[1], n);
      // two-slot pairs (rings, trinkets): items already worn stay in their row, only the real swap shows
      var keep = [], restC = cur.slice(), restB = [];
      best.forEach(function (b) {
        var j = restC.findIndex(function (c) { return c.id === b.id; });
        if (j >= 0) { keep.push(b); restC.splice(j, 1); } else restB.push(b);
      });
      var pairs = keep.map(function (k) { return [k, k]; });
      for (var i = 0; pairs.length < n; i++) pairs.push([restC[i] || null, restB[i] || restC[i] || null]);
      pairs.forEach(function (pr, i) { rows.push({ slot: s[0] + (n > 1 ? " " + (i + 1) : ""), cur: pr[0], best: pr[1] }); });
    });
    // weapons: best two-hander vs best main hand + off hand
    var b2 = top(TWOH, 1)[0], bm = top(MAIN, 1)[0], bo = top(OFF, 1)[0];
    var pairV = (bm ? bm.v : 0) + (bo ? bo.v : 0), twoV = b2 ? b2.v : -1;
    var cm = worn(MAIN.concat(TWOH), 1)[0] || null, co = worn(OFF, 1)[0] || null;
    if (twoV > pairV) {
      rows.push({ slot: "Two-hand", cur: cm, best: b2 });
      if (co) rows.push({ slot: "Off hand", cur: co, best: null });
    } else {
      rows.push({ slot: "Main hand", cur: cm, best: bm || cm });
      rows.push({ slot: "Off hand", cur: co, best: bo || co });
    }
    var total = 0;
    rows.forEach(function (r) {
      r.gain = (r.best ? r.best.v : 0) - (r.cur ? r.cur.v : 0);
      r.change = !!(r.best && (!r.cur || r.best.id !== r.cur.id));
      total += r.gain;
    });
    return { rows: rows, total: total, unknown: unknown, owned: exp.owned.length, equippedKnown: eq.length };
  }

  var api = { parseExport: parseExport, bestInBags: bestInBags, value: value };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ForeverBags = api;
})(this);
