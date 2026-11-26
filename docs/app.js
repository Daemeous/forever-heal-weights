(function () {
  "use strict";
  var W = window.ForeverWeights, $ = function (id) { return document.getElementById(id); };
  var an = null, result = null, view = "throughput", opts = {};
  var INPUTS = ["bonus", "intBonus", "sg", "casting", "spiBonus", "intHeal", "regen", "critPerInt", "lambda"];
  var STATS = [["healing", "Healing"], ["critRating", "Crit rating"], ["intellect", "Intellect"], ["spirit", "Spirit"], ["mp5", "MP5"]];

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
    an = new W.Analyzer(FOREVER_SPELLS);
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
      an = WCL.feed(new W.Analyzer(FOREVER_SPELLS), rep, events).finish();
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
  function pickHealer() {
    var guid = $("who").value, p = an.players[guid], d = W.defaults(p.mainClass);
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
    var cards = [["All boss fights", r.bosses], ["Whole log", r.whole], ["Trash and between pulls", r.trash]];
    $("cards").innerHTML = cards.filter(function (c) { return c[1] && c[1].healing; }).map(function (c) {
      var x = c[1], w = x[view];
      return '<div class="card"><h3>' + c[0] + '</h3><div class="meta">' + fmtT(x.duration) + " · " + fmtK(x.eff) + " healing · " + pct(x.overPct) +
        " overheal · " + x.hpm.toFixed(2) + " healing/mana · lowest mana " + pct(x.minMana) + '</div><div class="w"><span class="h">Stat</span><span class="h v">Weight</span><span class="h v">Points = 10 healing</span>' +
        STATS.map(function (s) { var v = w[s[0]]; return "<span>" + s[1] + '</span><span class="v">' + v.toFixed(2) + '</span><span class="v muted">' + (v > 0.001 ? (10 / v).toFixed(1) : "–") + "</span>"; }).join("") +
        "</div></div>";
    }).join("");

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
      }).join("") : '<td colspan="4" class="muted" style="text-align:left">not healing (no healer-spell heals)</td>';
      rows.push("<tr" + (dim ? ' class="dim"' : "") + '><td class="enc">' + esc(e.label) + ' <span class="muted">' + tod + "</span>" + tags + "</td><td>" + fmtT(e.duration) +
        "</td><td>" + fmtK(e.eff) + "</td><td>" + pct(e.overPct) + "</td><td>" + pct(e.minMana) + "</td>" + cells + "</tr>");
    });
    $("enc").innerHTML = "<thead>" + head + "</thead><tbody>" + (rows.join("") || '<tr><td colspan="9" class="muted">No encounters in this log.</td></tr>') + "</tbody>";

    var rc = r.realCost, keys = Object.keys(rc).sort();
    $("costs").innerHTML = keys.length ? "<table><tr><th>Spell</th><th>Logged cost</th><th>Real cost</th></tr>" + keys.map(function (k) {
      var i = k.lastIndexOf("|");
      return "<tr><td>" + esc(k.slice(0, i)) + "</td><td>" + k.slice(i + 1) + "</td><td>" + rc[k] + "</td></tr>";
    }).join("") + "</table>" : "No mana readings found.";
  }

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
