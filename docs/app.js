(function () {
  "use strict";
  var W = window.ForeverWeights, $ = function (id) { return document.getElementById(id); };
  var an = null, result = null, view = "manaLimited", opts = {};
  var INPUTS = ["bonus", "intBonus", "sg", "casting", "spiBonus", "intHeal", "regen", "critPerInt", "lambda"];
  var STATS = [["healing", "Healing"], ["critPct", "+1% crit"], ["intellect", "Intellect"], ["spirit", "Spirit"], ["mp5", "MP5"]];

  $("build").textContent = FOREVER_SPELLS.meta.build;

  // ------------------------------------------------------------------ file reading (chunked, stays responsive)
  var drop = $("drop"), file = $("file");
  drop.addEventListener("click", function () { file.click(); });
  drop.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } });
  drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
  drop.addEventListener("drop", function (e) { e.preventDefault(); drop.classList.remove("over"); load(e.dataTransfer.files); });
  file.addEventListener("change", function () { load(file.files); });

  function load(list) {
    var files = Array.prototype.slice.call(list || []).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    if (!files.length) return;
    var total = files.reduce(function (s, f) { return s + f.size; }, 0), done = 0, t0 = performance.now();
    an = new W.Analyzer(FOREVER_SPELLS, window.FOREVER_TALENTS);
    $("progress").style.display = "block"; $("setup").classList.add("hidden"); $("results").classList.add("hidden");
    var CH = 8 << 20, fi = 0, pos = 0, rest = "", dec = new TextDecoder("utf-8");
    status("Reading " + files.map(function (f) { return f.name; }).join(", ") + "…");
    function step() {
      if (fi >= files.length) return finish();
      var f = files[fi];
      f.slice(pos, pos + CH).arrayBuffer().then(function (buf) {
        pos += buf.byteLength; done += buf.byteLength;
        var last = pos >= f.size;
        var text = rest + dec.decode(buf, { stream: !last });
        var lines = text.split("\n");
        rest = last ? "" : lines.pop();
        for (var i = 0; i < lines.length; i++) an.line(lines[i]);
        if (last) { fi++; pos = 0; dec = new TextDecoder("utf-8"); }
        $("progress").firstElementChild.style.width = (100 * done / total).toFixed(1) + "%";
        setTimeout(step, 0);
      }).catch(function (e) { status("Could not read the file: " + e.message, true); });
    }
    function finish() {
      an.finish();
      var secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (showHealers(W.healers(an)))
        status("Read " + an.lines.toLocaleString() + " events and " + an.encounters.length + " encounters in " + secs + " s.");
      else status("Read " + an.lines.toLocaleString() + " events in " + secs + " s, but found no Priest / Paladin / Shaman / Druid healing. Is Advanced Combat Logging on?", true);
    }
    step();
  }

  function showHealers(hs) {
    if (!hs.length) return false;
    var sel = $("who"); sel.innerHTML = "";
    hs.forEach(function (h) {
      var o = document.createElement("option");
      o.value = h.guid; o.textContent = h.name.split("-")[0] + " (" + h.cls + ", " + fmtK(h.eff) + " healing)";
      sel.appendChild(o);
    });
    $("setup").classList.remove("hidden");
    pickHealer();
    return true;
  }

  // ------------------------------------------------------------------ source tabs
  document.querySelectorAll(".btn[data-src]").forEach(function (b) {
    b.addEventListener("click", function () { setSource(b.getAttribute("data-src")); });
  });
  function setSource(src) {
    document.querySelectorAll(".btn[data-src]").forEach(function (x) { x.classList.toggle("on", x.getAttribute("data-src") === src); });
    $("src-file").classList.toggle("hidden", src !== "file");
    $("src-wcl").classList.toggle("hidden", src !== "wcl");
    try { localStorage.setItem("fhw:src", src); } catch (e) {}
    if (src === "wcl") wclAuthNote();
  }

  // ------------------------------------------------------------------ Warcraft Logs
  var WCL = window.ForeverWCL, rep = null;
  function wclAuthNote() {
    var el = $("wclauth");
    if (!WCL.configured()) { el.innerHTML = '<b class="err">Not set up on this copy of the page yet</b> (no Warcraft Logs client ID in wcl-config.js).'; return; }
    if (WCL.signedIn()) { el.innerHTML = 'Signed in to Warcraft Logs. <a href="#" id="wclout">Sign out</a>'; $("wclout").onclick = function (e) { e.preventDefault(); WCL.signOut(); wclAuthNote(); }; }
    else el.textContent = "You will be asked to sign in when you load a report.";
  }
  function wclFail(e) {
    $("progress").style.display = "none";
    if (e && e.auth) { status("Signing in to Warcraft Logs…"); WCL.signIn($("wclurl").value).catch(wclFail); return; }
    status(e && e.message ? e.message : String(e), true);
  }
  $("wclgo").addEventListener("click", function () {
    var code = WCL.reportCode($("wclurl").value);
    if (!code) { status("That doesn't look like a Warcraft Logs report link (…/reports/<16 characters>).", true); return; }
    if (!WCL.configured()) { wclAuthNote(); status("The Warcraft Logs option isn't set up on this copy of the page.", true); return; }
    if (!WCL.signedIn()) { status("Signing in to Warcraft Logs…"); WCL.signIn($("wclurl").value).catch(wclFail); return; }
    status("Loading report " + code + "…");
    $("wclpick").classList.add("hidden"); $("setup").classList.add("hidden"); $("results").classList.add("hidden");
    WCL.loadReport(code).then(function (r) {
      rep = r;
      if (!r.healers.length) { status("No Priest / Paladin / Shaman / Druid healing found in “" + r.title + "”.", true); return; }
      var sel = $("wclwho"); sel.innerHTML = "";
      r.healers.forEach(function (h) {
        var o = document.createElement("option"); o.value = h.id;
        o.textContent = h.name + " (" + h.cls + ", " + fmtK(h.healing) + " healing)"; sel.appendChild(o);
      });
      $("wclpick").classList.remove("hidden");
      var nb = r.fights.filter(function (f) { return f.encounterID; }).length;
      status("“" + r.title + "”" + (r.zone ? " (" + r.zone.name + ")" : "") + ": " + nb + " boss pulls. Pick a healer and press Analyse.");
      wclAuthNote();
    }).catch(wclFail);
  });
  $("wclrun").addEventListener("click", function () {
    if (!rep) return;
    var id = +$("wclwho").value, h = rep.healers.filter(function (x) { return x.id === id; })[0];
    $("progress").style.display = "block"; $("progress").firstElementChild.style.width = "0%";
    status("Downloading " + h.name + "'s events…");
    var t0 = performance.now();
    WCL.loadEvents(rep, id, function (n, frac) {
      $("progress").firstElementChild.style.width = (100 * Math.min(1, frac)).toFixed(1) + "%";
      status("Downloaded " + n.toLocaleString() + " events…");
    }).then(function (events) {
      wclSample(rep, events);
      an = WCL.feed(new W.Analyzer(FOREVER_SPELLS, window.FOREVER_TALENTS), rep, events).finish();
      var only = W.healers(an).filter(function (x) { return x.guid === "Player-" + id; });
      var secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (showHealers(only)) status("Read " + events.length.toLocaleString() + " events and " + an.encounters.length + " boss pulls in " + secs + " s.");
      else status("Downloaded " + events.length.toLocaleString() + " events, but none of " + h.name + "'s heals could be read. Was Advanced Combat Logging on?", true);
    }).catch(wclFail);
  });

  // debug: a small sample of the raw API data, so the adapter's field assumptions can be checked
  function wclSample(r, events) {
    var pick = {}, out = [];
    events.forEach(function (e) { var k = e.type; pick[k] = (pick[k] || 0) + 1; if (pick[k] <= 25) out.push(e); });
    var blob = new Blob([JSON.stringify({ queries: WCL.debugInfo(), report: { code: r.code, startTime: r.startTime, endTime: r.endTime, fights: r.fights.slice(0, 15),
      actors: r.masterData.actors.length, sampleActors: r.masterData.actors.slice(0, 15) }, typeCounts: pick, events: out }, null, 1)], { type: "application/json" });
    var a = $("wcldebug");
    a.href = URL.createObjectURL(blob); a.download = "wcl-sample-" + r.code + ".json"; a.classList.remove("hidden");
  }

  $("wclremember").checked = WCL.remember();
  $("wclremember").addEventListener("change", function () { WCL.remember($("wclremember").checked); });

  // finish a sign-in redirect, then continue loading the report that started it
  try { if (localStorage.getItem("fhw:src") === "wcl") setSource("wcl"); } catch (e) {}
  WCL.completeSignIn().then(function (resume) {
    if (resume) { setSource("wcl"); $("wclurl").value = resume; $("wclgo").click(); }
  }).catch(function (e) { setSource("wcl"); wclFail(e); });

  function status(msg, err) { var s = $("status"); s.textContent = msg; s.className = err ? "err" : "muted"; }

  // ------------------------------------------------------------------ inputs
  $("who").addEventListener("change", pickHealer);
  INPUTS.forEach(function (k) { $(k).addEventListener("input", recompute); });

  // inputs start from what the log itself shows (talents, and bonus healing solved from the heals); edits last for
  // this page visit only, so an old edit never silently overrides a new log
  var detected = null;
  var FM = ["fmMana", "fmSpi", "fmMp5", "fmO120", "fmO180", "fmO360"];
  FM.forEach(function (k) { $(k).addEventListener("input", recompute); });

  function pickHealer() {
    var guid = $("who").value, p = an.players[guid], d = W.defaults(p.mainClass);
    var fi = W.fightInputs(an, guid);
    $("fmMana").value = fi.maxMana || ""; $("fmSpi").value = fi.spirit || "";
    detected = W.detect(an, guid, window.FOREVER_TALENTS);
    if (detected.talents.length) for (var k in detected.inputs) d[k] = detected.inputs[k];
    if (detected.bonus) d.bonus = detected.bonus.value;
    INPUTS.forEach(function (k) { $(k).value = d[k]; });
    renderDetected();
    recompute();
  }

  function renderDetected() {
    var el = $("detected"), D = detected, parts = [];
    if (!D || (!D.talents.length && !D.bonus)) {
      el.innerHTML = "Couldn't read this healer's talents from the log, so the inputs are class defaults: please check them.";
      return;
    }
    if (D.bonus) {
      var sp = D.bonus.spells.map(function (x) { return esc(x.spell) + " " + Math.round(x.B); }).join(", ");
      parts.push("<b>Bonus healing ≈ " + D.bonus.value + "</b>, worked out from your heals (" + D.bonus.spells.length + " spell" +
        (D.bonus.spells.length > 1 ? "s" : "") + ": " + sp + "). It includes Spirit or Intellect turned into healing by talents, so it can be higher than the character sheet.");
    } else parts.push("<b>Bonus healing</b> couldn't be worked out (too few heals from full-coefficient ranks); enter it from your character sheet.");
    if (D.talents.length) {
      var t = D.talents.filter(function (x) { var f = x.fx; return f.int || f.spi || f.sg || f.intHeal || f.casting || (f.heal && f.heal.length); })
        .map(function (x) { return esc(x.name) + " " + x.rank + "/" + x.max; });
      parts.push("<b>Talents read from the log</b>: " + (t.join(", ") || "none that change these inputs") + ".");
    }
    el.innerHTML = parts.join(" ");
  }

  function recompute() {
    var guid = $("who").value;
    if (!guid) return;
    var o = {};
    INPUTS.forEach(function (k) { o[k] = parseFloat($(k).value) || 0; });
    opts = o;
    result = W.analyse(an, guid, o);
    var fv = function (k) { return parseFloat($(k).value) || 0; }, fm = { maxMana: fv("fmMana"), spirit: fv("fmSpi"), mp5: fv("fmMp5") };
    result.fights = W.fights(result, o, [120, 180, 360].map(function (L) {
      return { seconds: L, maxMana: fm.maxMana, spirit: fm.spirit, mp5: fm.mp5, other: fv("fmO" + L) };
    }));
    result.fights.forEach(function (f) { result["f" + f.seconds] = f; });
    render();
  }

  document.querySelectorAll(".btn[data-view]").forEach(function (b) {
    b.addEventListener("click", function () {
      view = b.getAttribute("data-view");
      document.querySelectorAll(".btn[data-view]").forEach(function (x) { x.classList.toggle("on", x === b); });
      render();
    });
  });

  // ------------------------------------------------------------------ rendering
  function fmtK(x) { return x >= 1e6 ? (x / 1e6).toFixed(2) + "M" : x >= 1e4 ? Math.round(x / 1e3) + "k" : Math.round(x).toLocaleString(); }
  function fmtT(s) { s = Math.round(s); return s >= 3600 ? Math.floor(s / 3600) + "h " + Math.floor(s % 3600 / 60) + "m" : s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s"; }
  function pct(x) { return Math.round(100 * x) + "%"; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function render() {
    var r = result, P = r.player;
    $("results").classList.remove("hidden");
    $("rtitle").textContent = P.name.split("-")[0] + " · " + P.cls + (P.info ? " · " + P.info.int + " Int, " + P.info.spi + " Spirit" : "");
    $("viewnote").innerHTML = view === "throughput"
      ? "Mana treated as free: what makes your heals bigger. Use this if you rarely run low."
      : "Mana valued at <b>" + r.lambda.toFixed(2) + " healing per mana</b> (your healing per mana in boss fights, after talent discounts and refunds). Use this if you run dry.";
    $("viewnote").innerHTML += " Your crits heal for <b>\u00d7" + r.whole.critMult.toFixed(2) + "</b> (measured from your heals).";
    var cards = [["All boss fights", r.bosses], ["Whole log", r.whole], ["Trash and between pulls", r.trash]];
    $("cards").innerHTML = cards.filter(function (c) { return c[1] && c[1].healing; }).map(function (c) {
      var x = c[1], w = x[view];
      return '<div class="card"><h3>' + c[0] + '</h3><div class="meta">' + fmtT(x.duration) + " · " + fmtK(x.eff) + " healing · " + pct(x.overPct) +
        " overheal · " + x.hpm.toFixed(2) + " healing/mana · lowest mana " + pct(x.minMana) + '</div><div class="w"><span class="h">Stat</span><span class="h v">Worth (+healing)</span>' +
        STATS.map(function (s) { var v = w[s[0]]; return "<span>" + s[1] + '</span><span class="v">' + v.toFixed(2) + "</span>"; }).join("") +
        "</div></div>";
    }).join("");
    var base = r.bosses && r.bosses.spentHeal > 2000 ? "your boss fights" : "the whole log (no boss fights)";
    $("fcards").innerHTML = r.fights.length ? r.fights.map(function (f) {
      var spare = f.funded >= 1, w = f.manaLimited;
      return '<div class="card"><h3>' + esc(f.label.replace(" (estimate)", "")) + (spare ? ' <span class="tag">mana to spare</span>' : ' <span class="tag low">mana-limited</span>') +
        '</h3><div class="meta">' + Math.round(f.mana).toLocaleString() + " mana (" + f.regen.toFixed(1) + "/sec regen) · needs " + Math.round(f.need).toLocaleString() +
        " at your pace · funded " + pct(f.funded) + " · 1 mana = " + f.lambda.toFixed(3) + " healing" + '</div><div class="w"><span class="h">Stat</span><span class="h v">Worth (+healing)</span>' +
        STATS.map(function (s) { return "<span>" + s[1] + '</span><span class="v">' + w[s[0]].toFixed(2) + "</span>"; }).join("") +
        "</div></div>";
    }).join("") + '<p class="note" style="grid-column:1/-1;margin:0">From ' + base + "." + "</p>"
      : '<p class="note">Not enough healing with mana readings in this log to build the estimate.</p>';

    var max = {};
    STATS.forEach(function (s) { max[s[0]] = 0; });
    r.encounters.forEach(function (e) { if (e.healing) STATS.forEach(function (s) { max[s[0]] = Math.max(max[s[0]], e[view][s[0]]); }); });
    var head = "<tr><th>Encounter</th><th>Length</th><th>Healing</th><th>Overheal</th><th>Lowest mana</th>" +
      STATS.slice(1).map(function (s) { return "<th>" + s[1] + "</th>"; }).join("") + "</tr>";
    var rows = [], lastDay = null;
    r.encounters.forEach(function (e) {
      var day = new Date(e.start * 1000).toISOString().slice(0, 10), tod = new Date(e.start * 1000).toISOString().slice(11, 16);
      if (day !== lastDay) { rows.push('<tr class="sep"><td colspan="9">' + day + "</td></tr>"); lastDay = day; }
      var tags = (e.kill === false ? ' <span class="tag wipe">wipe</span>' : "") + (e.lowMana ? ' <span class="tag low">ran low</span>' : "");
      var dim = !e.healing || (view === "manaLimited" && e.minMana > 0.4);
      var cells = e.healing ? STATS.slice(1).map(function (s) {
        var v = e[view][s[0]], m = max[s[0]] || 1;
        return '<td class="cell"><div class="b" style="width:' + Math.min(100, 100 * v / m).toFixed(0) + '%"></div><span>' + v.toFixed(2) + "</span></td>";
      }).join("") : '<td colspan="4" class="muted" style="text-align:left">' + (e.offspec ? "off-spec (no healing talents): left out of every total" : "not healing (no healer-spell heals)") + "</td>";
      rows.push("<tr" + (dim ? ' class="dim"' : "") + '><td class="enc">' + esc(e.label) + ' <span class="muted">' + tod + "</span>" + tags + "</td><td>" + fmtT(e.duration) +
        "</td><td>" + fmtK(e.eff) + "</td><td>" + pct(e.overPct) + "</td><td>" + pct(e.minMana) + "</td>" + cells + "</tr>");
    });
    $("enc").innerHTML = "<thead>" + head + "</thead><tbody>" + (rows.join("") || '<tr><td colspan="9" class="muted">No encounters in this log.</td></tr>') + "</tbody>";

    renderSpellScopes();
    renderBags();
    renderBis();
    var rc = r.realCost, keys = Object.keys(rc).sort();
    $("costs").innerHTML = keys.length ? "<table><tr><th>Spell</th><th>Logged cost</th><th>Real cost</th></tr>" + keys.map(function (k) {
      var i = k.lastIndexOf("|");
      return "<tr><td>" + esc(k.slice(0, i)) + "</td><td>" + k.slice(i + 1) + "</td><td>" + rc[k] + "</td></tr>";
    }).join("") + "</table>" : "No mana readings found.";
  }

  // ------------------------------------------------------------------ per-spell table
  var scopeRows = [];
  function renderSpellScopes() {
    var r = result, sel = $("spscope"), keep = sel.value;
    scopeRows = [["All boss fights", r.bosses], ["Whole log", r.whole], ["Trash and between pulls", r.trash]].filter(function (x) { return x[1]; });
    r.encounters.forEach(function (e) {
      if (e.healing) scopeRows.push([e.label + " " + new Date(e.start * 1000).toISOString().slice(11, 16) + (e.kill === false ? " (wipe)" : ""), e]);
    });
    sel.innerHTML = scopeRows.map(function (x, i) { return '<option value="' + i + '">' + esc(x[0]) + "</option>"; }).join("");
    if (keep && +keep < scopeRows.length) sel.value = keep;
    renderSpells();
  }
  $("spscope").addEventListener("change", renderSpells);
  function renderSpells() {
    var row = scopeRows[+$("spscope").value || 0];
    if (!row) { $("spells").innerHTML = ""; return; }
    var list = row[1].spells || [], tot = row[1].eff || 1;
    $("spells").innerHTML = "<thead><tr><th>Spell</th><th>Casts</th><th>Mana</th><th>Healing</th><th>Share</th><th>Overheal</th><th>Crit</th><th>Healing per mana</th></tr></thead><tbody>" +
      list.map(function (x) {
        var hpm = x.mana > 0 ? (x.eff / x.mana).toFixed(2) : "–";
        return "<tr><td>" + esc(x.name) + "</td><td>" + (x.casts || "–") + "</td><td>" + (x.mana ? fmtK(x.mana) : "–") + "</td><td>" + fmtK(x.eff) +
          "</td><td>" + pct(x.eff / tot) + "</td><td>" + (x.eff + x.over > 0 && !x.absorb ? pct(x.over / (x.eff + x.over)) : "–") +
          "</td><td>" + (x.hits ? pct(x.crits / x.hits) : "–") + "</td><td>" + hpm + "</td></tr>";
      }).join("") + "</tbody>";
  }

  // ------------------------------------------------------------------ best in bags
  var bagExp = null;
  $("baggo").addEventListener("click", function () {
    try { bagExp = window.ForeverBags.parseExport($("bagtext").value); }
    catch (e) { bagExp = null; $("bagnote").innerHTML = '<span class="err">' + esc(e.message) + "</span>"; $("bags").innerHTML = ""; return; }
    renderBags(); renderBis();
  });
  $("bagscope").addEventListener("change", function () { renderBags(); renderBis(); });
  // what the on-use / proc estimates (bags.js procValue) need from the chosen scope; fight models use their base scope's
  // rates (casts per second of casting, healing per +1 healing) with the model's own healing per mana
  function gearCtx() {
    var r = result, scope = r[$("bagscope").value] || r.whole, b = scope.base || scope;
    var act = b.rates && b.rates.active > 0 ? b.rates.active : b.duration;
    return { scope: scope, w: scope[view], lambda: view === "manaLimited" ? (scope.lambda != null ? scope.lambda : r.lambda) : 0,
             L: +$("fightlen").value || 180, r: b, h1: act > 0 ? b.healPerPoint / act : 0,
             pulls: r.pulls || [], policy: $("cdpolicy").value, countAll: ["whole", "trash"].indexOf($("bagscope").value) >= 0,
             spirit: r.player.info ? r.player.info.spi || 0 : 0, procs: window.FOREVER_PROCS };
  }
  function renderBags() {
    if (!bagExp || !result) return;
    var r = result, ctx = gearCtx(), w = ctx.w;
    var cls = bagExp.cls || r.player.cls, lvl = bagExp.level || 60;
    var B = window.ForeverBags.bestInBags(bagExp, cls, lvl, w, window.FOREVER_ITEMS, ctx);
    function cell(x, set) {
      return x ? esc(x.name) + ' <span class="muted">' + x.v.toFixed(0) + "</span>" :
        '<span class="muted">' + (set ? "none" : "empty, or an item without healer stats") + "</span>";
    }
    $("bags").innerHTML = "<thead><tr><th>Slot</th><th>Wearing</th><th>Best you own</th><th>Gain</th></tr></thead><tbody>" +
      B.rows.map(function (x) {
        var st = x.slot === "Set bonuses";
        return "<tr" + (x.change ? "" : ' class="dim"') + "><td>" + x.slot + "</td><td>" + cell(x.cur, st) + "</td><td>" + (x.change ? "<b>" + cell(x.best, st) + "</b>" : cell(x.best, st)) +
          "</td><td>" + (x.change ? (x.gain >= 0 ? "+" : "−") + Math.abs(x.gain).toFixed(0) : "") + "</td></tr>";
      }).join("") + "</tbody>";
    $("bagnote").innerHTML = (bagExp.name ? esc(bagExp.name) + " \u00b7 " : "") + cls + " level " + lvl + " \u00b7 " + esc(bagExp.format || "export") +
      (bagExp.bank ? " (bank included)" : " (equipped + bags; no bank in this export)") + " \u00b7 " + B.owned + " items read" +
      (B.unknown ? " (" + B.unknown + " have no healer stats or aren't in the item data)" : "") +
      " \u00b7 values in +healing (" + (view === "manaLimited" ? "mana-limited" : "throughput") + ", " + $("bagscope").selectedOptions[0].text.toLowerCase() + ")" +
      " \u00b7 <b>total gain +" + B.total.toFixed(0) + " healing</b>";
  }

  // ------------------------------------------------------------------ best in slot + enchants / consumables
  document.querySelectorAll(".bistier").forEach(function (c) { c.addEventListener("change", renderBis); });
  $("fightlen").addEventListener("input", function () { renderBags(); renderBis(); });
  $("cdpolicy").addEventListener("change", function () { renderBags(); renderBis(); });
  function renderBis() {
    if (!result) return;
    var r = result, ctx = gearCtx(), w = ctx.w, FB = window.ForeverBags;
    var tiers = {};
    document.querySelectorAll(".bistier").forEach(function (c) { if (c.checked) tiers[c.value] = 1; });
    var rows = FB.bisList(r.player.cls, 60, w, window.FOREVER_ITEMS, { n: 3, tiers: tiers, ctx: ctx });
    function it(x) {
      return x ? esc(x.name) + (x.proc ? ' <span class="tag">use / proc</span>' : "") + ' <span class="muted">' + x.v.toFixed(0) +
        '</span><br><span class="note">' + esc(x.src) + "</span>" : "";
    }
    $("bis").innerHTML = "<thead><tr><th>Slot</th><th>Best</th><th>2nd</th><th>3rd</th><th>4th</th></tr></thead><tbody>" +
      rows.map(function (x) {
        return '<tr><td>' + x.slot + "</td>" + [0, 1, 2, 3].map(function (i) { return '<td class="enc" style="text-align:left">' + it(x.items[i]) + "</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody>";
    var ex = FB.extrasValues(window.FOREVER_EXTRAS, ctx);
    var tagNew = function (x) { return x.new ? ' <span class="tag">new</span>' : ""; };
    var tip = function (x) { return x.note || x.proc ? ' title="' + esc(x.note || x.proc) + '"' : ""; };
    var bySlot = {};
    ex.enchants.forEach(function (e) { (bySlot[e.slot] = bySlot[e.slot] || []).push(e); });
    // set bonuses: each set on its own against the #1 picks above, best number of pieces first
    var picked = {};
    (rows.setPick || []).forEach(function (c) { picked[c.sid] = c; });
    $("sets").innerHTML = (rows.sets || []).length ? "<thead><tr><th>Set</th><th>Wear</th><th>Bonuses counted</th><th>Bonus worth</th><th>Net vs the picks above</th></tr></thead><tbody>" +
      rows.sets.slice(0, 15).map(function (e) {
        var S = ctx.procs.sets[e.sid];
        var bon = S.b.filter(function (b) { return b.k <= e.k; }).map(function (b) {
          var pv = b.kind === "stat" ? null : FB.procValue(b, ctx);
          return b.k + "pc: " + esc(b.text) + (b.note ? ' <span class="note">(' + esc(b.note) + ")</span>" : "") +
            ' <span class="muted">' + FB.setBonusValue(b, ctx).toFixed(0) + "</span>" + (pv && pv.how ? ' <span class="note">(' + esc(pv.how) + ")</span>" : "");
        }).join("<br>");
        var pieces = e.pieces.map(function (o) { return esc(o.slot) + ": " + esc(o.it.name) + (o.loss > 0.5 ? ' <span class="note">(−' + o.loss.toFixed(0) + ")</span>" : ""); }).join("<br>");
        return "<tr" + (e.gain > 0.5 ? "" : ' class="dim"') + '><td class="enc">' + esc(e.name) + (picked[e.sid] ? ' <span class="tag">worth it</span>' : "") +
          '</td><td class="enc" style="text-align:left">' + e.k + " pieces<br>" + pieces + '</td><td class="enc" style="text-align:left">' + bon +
          "</td><td>" + e.v.toFixed(0) + "</td><td>" + (e.gain >= 0 ? "+" : "−") + Math.abs(e.gain).toFixed(0) + "</td></tr>";
      }).join("") + "</tbody>" : '<tbody><tr><td class="note">No set with a healer bonus among these sources.</td></tr></tbody>';
    $("ench").innerHTML = "<thead><tr><th>Slot</th><th>Enchant</th><th>Worth</th></tr></thead><tbody>" +
      Object.keys(bySlot).map(function (sl) {
        return bySlot[sl].sort(function (a, b) { return b.v - a.v; }).map(function (e, i) {
          return "<tr" + (i ? ' class="dim"' : "") + tip(e) + "><td>" + (i ? "" : esc(sl)) + '</td><td class="enc">' + esc(e.n) + tagNew(e) +
            (e.est ? ' <span class="note">(proc: ' + esc(e.est) + ")</span>" : e.proc ? ' <span class="note">(proc, not scored)</span>' : "") +
            "</td><td>" + e.v.toFixed(0) + "</td></tr>";
        }).join("");
      }).join("") + "</tbody>";
    $("cons").innerHTML = "<thead><tr><th>Item</th><th>Type</th><th>Worth</th><th>Mana \u2192 healing</th></tr></thead><tbody>" +
      ex.consumables.sort(function (a, b) { return b.v - a.v; }).map(function (c) {
        return "<tr" + tip(c) + '><td class="enc">' + esc(c.n) + tagNew(c) + "</td><td>" + c.kind + "</td><td>" + c.v.toFixed(0) +
          "</td><td>" + (c.manaHeal ? Math.round(c.manaHeal).toLocaleString() + (c.uses > 1 ? " (" + c.uses + " uses)" : "") : "") + "</td></tr>";
      }).join("") + "</tbody>";
    // on-use and proc items this class can use
    var own = {};
    if (bagExp) bagExp.owned.forEach(function (id) { own[id] = 1; });
    var TN = { P: "", V: "PvP", R: "Classic raid", L: "later content", F: "other faction" };
    $("procs").innerHTML = "<thead><tr><th>Item</th><th>Effect</th><th>Effect worth</th><th>With its stats</th><th>How</th></tr></thead><tbody>" +
      FB.procList(r.player.cls, 60, ctx, window.FOREVER_ITEMS).map(function (x) {
        var tags = (own[x.id] ? ' <span class="tag">you own it</span>' : "") +
          (x.tier && TN[x.tier[0]] ? ' <span class="note">(' + TN[x.tier[0]] + ")</span>" : !x.tier ? ' <span class="note">(no known source)</span>' : "");
        return "<tr" + (x.pv > 0.5 ? "" : ' class="dim"') + ' title="' + esc(x.text) + '"><td class="enc">' + esc(x.name) + tags +
          '<br><span class="note">' + esc(x.src) + '</span></td><td class="enc" style="text-align:left">' + esc(x.text) +
          (x.note ? ' <span class="note">(' + esc(x.note) + ")</span>" : "") + "</td><td>" + (x.kind === "none" ? "–" : x.pv.toFixed(0)) +
          "</td><td>" + x.v.toFixed(0) + '</td><td class="note" style="text-align:left">' + esc(x.how) + "</td></tr>";
      }).join("") + "</tbody>";
  }

  // ------------------------------------------------------------------ copy a one-line summary (Discord etc.)
  $("copy").addEventListener("click", function () {
    if (!result) return;
    var r = result, b = r.bosses || r.whole, w = b[view], P = r.player;
    var txt = P.name.split("-")[0] + " (" + P.cls + ") \u2013 stat weights from " + (r.bosses ? "all boss fights" : "the whole log") + ", " +
      (view === "manaLimited" ? "mana-limited" : "throughput") + ", +1 healing = 1.00: " +
      STATS.slice(1).map(function (s) { return s[1] + " " + w[s[0]].toFixed(2); }).join(" \u00b7 ") +
      " (bonus healing " + Math.round(opts.bonus) + ", " + b.hpm.toFixed(2) + " healing/mana, " + pct(b.overPct) + " overheal) " + location.origin + location.pathname;
    function done() { $("copied").textContent = " Copied."; setTimeout(function () { $("copied").textContent = ""; }, 2500); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { fallback(); });
    else fallback();
    function fallback() {
      var ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { $("copied").textContent = " " + txt; }
      document.body.removeChild(ta);
    }
  });

  $("csv").addEventListener("click", function () {
    if (!result) return;
    var cols = ["encounter", "start", "kill", "seconds", "healing", "overheal_pct", "lowest_mana_pct", "healing_per_mana"];
    ["throughput", "manaLimited"].forEach(function (v) { STATS.forEach(function (s) { cols.push(v + "_" + s[0]); }); });
    var lines = [cols.join(",")];
    var all = [["All boss fights", result.bosses], ["Whole log", result.whole], ["Trash", result.trash]].concat(result.encounters.map(function (e) { return [e.label, e]; }));
    all.forEach(function (a) {
      var e = a[1]; if (!e) return;
      var row = ['"' + a[0].replace(/"/g, '""') + '"', e.start ? new Date(e.start * 1000).toISOString().replace("T", " ").slice(0, 19) : "", e.kill == null ? "" : e.kill ? "kill" : "wipe",
        Math.round(e.duration), Math.round(e.eff), (100 * e.overPct).toFixed(1), (100 * e.minMana).toFixed(0), e.hpm.toFixed(2)];
      ["throughput", "manaLimited"].forEach(function (v) { STATS.forEach(function (s) { row.push(e.healing ? e[v][s[0]].toFixed(3) : ""); }); });
      lines.push(row.join(","));
    });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = "stat-weights-" + result.player.name.split("-")[0] + ".csv";
    a.click();
  });
})();
