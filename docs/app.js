(function () {
  "use strict";
  var W = window.ForeverWeights, $ = function (id) { return document.getElementById(id); };
  var an = null, result = null, view = "throughput", opts = {};
  var INPUTS = ["bonus", "intBonus", "sg", "casting", "regen", "critPerInt", "lambda"];
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
      var hs = W.healers(an);
      var secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (!hs.length) { status("Read " + an.lines.toLocaleString() + " events in " + secs + " s, but found no Priest / Paladin / Shaman / Druid healing. Is Advanced Combat Logging on?", true); return; }
      status("Read " + an.lines.toLocaleString() + " events and " + an.encounters.length + " encounters in " + secs + " s.");
      var sel = $("who"); sel.innerHTML = "";
      hs.forEach(function (h) {
        var o = document.createElement("option");
        o.value = h.guid; o.textContent = h.name.split("-")[0] + " (" + h.cls + ", " + fmtK(h.eff) + " healing)";
        sel.appendChild(o);
      });
      $("setup").classList.remove("hidden");
      pickHealer();
    }
    step();
  }

  function status(msg, err) { var s = $("status"); s.textContent = msg; s.className = err ? "err" : "muted"; }

  // ------------------------------------------------------------------ inputs
  $("who").addEventListener("change", pickHealer);
  INPUTS.forEach(function (k) { $(k).addEventListener("input", recompute); });

  function storeKey(guid) { return "fhw:" + guid; }
  function pickHealer() {
    var guid = $("who").value, p = an.players[guid], d = W.defaults(p.mainClass);
    try { var saved = JSON.parse(localStorage.getItem(storeKey(guid)) || "null"); if (saved) for (var k in saved) d[k] = saved[k]; } catch (e) {}
    INPUTS.forEach(function (k) { $(k).value = d[k]; });
    recompute();
  }

  function recompute() {
    var guid = $("who").value;
    if (!guid) return;
    var o = {};
    INPUTS.forEach(function (k) { o[k] = parseFloat($(k).value) || 0; });
    try { localStorage.setItem(storeKey(guid), JSON.stringify(o)); } catch (e) {}
    opts = o;
    result = W.analyse(an, guid, o);
    render();
  }

  document.querySelectorAll(".seg .btn").forEach(function (b) {
    b.addEventListener("click", function () {
      view = b.getAttribute("data-view");
      document.querySelectorAll(".seg .btn").forEach(function (x) { x.classList.toggle("on", x === b); });
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
