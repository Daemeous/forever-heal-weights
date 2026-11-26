// Warcraft Logs (forever.warcraftlogs.com) source: OAuth PKCE sign-in, report download, and conversion of the
// API's JSON events into the analyser's normalised events. Works in the browser; the adapter part also in Node.
(function (root) {
  "use strict";
  var CFG = (root && root.WCL_CONFIG) || {};
  var SITE = CFG.site || "https://forever.warcraftlogs.com";
  var CLIENT_ID = CFG.clientId || "";
  var HEALER_CLASSES = { Priest: 1, Paladin: 1, Shaman: 1, Druid: 1 };
  var PAGE = 10000;

  // ------------------------------------------------------------------ helpers
  function reportCode(url) {
    var m = String(url || "").trim().match(/reports\/(?:a:)?([A-Za-z0-9]{16})/) || String(url || "").trim().match(/^([A-Za-z0-9]{16})$/);
    return m ? m[1] : null;
  }
  function fightFromUrl(url) { var m = String(url || "").match(/fight=(\d+|last)/); return m ? m[1] : null; }

  function b64url(bytes) {
    var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomString(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
  function sha256(str) { return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)).then(function (h) { return b64url(new Uint8Array(h)); }); }
  function redirectUri() { return location.origin + location.pathname; }

  // ------------------------------------------------------------------ auth (Authorization Code + PKCE, no secret)
  function token() {
    try {
      var t = JSON.parse(sessionStorage.getItem("wcl:token") || "null");
      if (t && t.expires > Date.now() + 60000) return t.access;
    } catch (e) {}
    return null;
  }

  function signIn(resume) {
    if (!CLIENT_ID) return Promise.reject(new Error("This copy of the page has no Warcraft Logs client ID set (see wcl-config.js)."));
    var verifier = randomString(48), state = randomString(16);
    try {
      sessionStorage.setItem("wcl:pkce", JSON.stringify({ verifier: verifier, state: state, resume: resume || null }));
    } catch (e) { return Promise.reject(new Error("The browser blocked session storage, which sign-in needs.")); }
    return sha256(verifier).then(function (challenge) {
      location.href = SITE + "/oauth/authorize?" + new URLSearchParams({
        client_id: CLIENT_ID, code_challenge: challenge, code_challenge_method: "S256", state: state,
        redirect_uri: redirectUri(), response_type: "code",
      }).toString();
    });
  }

  // call on page load: finishes a sign-in redirect; resolves to the saved "resume" value (the report link) or null
  function completeSignIn() {
    var q = new URLSearchParams(location.search);
    if (!q.get("code") && !q.get("error")) return Promise.resolve(null);
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem("wcl:pkce") || "null"); sessionStorage.removeItem("wcl:pkce"); } catch (e) {}
    history.replaceState(null, "", redirectUri() + location.hash);
    if (q.get("error")) return Promise.reject(new Error("Warcraft Logs sign-in was cancelled or refused (" + q.get("error") + ")."));
    if (!saved || saved.state !== q.get("state")) return Promise.reject(new Error("Sign-in state did not match; please try again."));
    return fetch(SITE + "/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code_verifier: saved.verifier,
                                  redirect_uri: redirectUri(), code: q.get("code") }).toString(),
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error("Token exchange failed (" + r.status + "): " + t.slice(0, 200)); });
      return r.json();
    }).then(function (j) {
      sessionStorage.setItem("wcl:token", JSON.stringify({ access: j.access_token, expires: Date.now() + 1000 * (j.expires_in || 3600) }));
      return saved.resume;
    });
  }

  function signOut() { try { sessionStorage.removeItem("wcl:token"); } catch (e) {} }

  // ------------------------------------------------------------------ API
  function gql(query, vars) {
    var tk = token();
    if (!tk) return Promise.reject(Object.assign(new Error("Not signed in to Warcraft Logs."), { auth: true }));
    return fetch(SITE + "/api/v2/user", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tk },
      body: JSON.stringify({ query: query, variables: vars || {} }),
    }).then(function (r) {
      if (r.status === 401) { signOut(); throw Object.assign(new Error("Warcraft Logs sign-in expired."), { auth: true }); }
      if (r.status === 429) throw new Error("Warcraft Logs rate limit reached; wait a while and try again.");
      return r.json();
    }).then(function (j) {
      if (j.errors && j.errors.length) throw new Error("Warcraft Logs: " + j.errors.map(function (e) { return e.message; }).join("; "));
      return j.data;
    });
  }

  var META_Q = "query($code:String!){reportData{report(code:$code){code title startTime endTime zone{name}" +
    " fights{id name startTime endTime kill encounterID}" +
    " masterData{actors{id name type subType server petOwner} abilities{gameID name}}}}}";
  var TABLE_Q = "query($code:String!,$s:Float!,$e:Float!){reportData{report(code:$code){table(dataType:Healing,startTime:$s,endTime:$e)}}}";
  var EVENTS_Q = "query($code:String!,$s:Float!,$e:Float!,$f:String){reportData{report(code:$code){" +
    "events(startTime:$s,endTime:$e,dataType:All,includeResources:true,limit:" + PAGE + ",filterExpression:$f){data nextPageTimestamp}}}}";

  // report metadata + the healers in it (Priest/Paladin/Shaman/Druid with healing done, most first)
  function loadReport(code) {
    return gql(META_Q, { code: code }).then(function (d) {
      var rep = d.reportData.report;
      if (!rep) throw new Error("Report " + code + " not found (or it is private).");
      var span = { s: 0, e: rep.endTime - rep.startTime };
      return gql(TABLE_Q, { code: code, s: span.s, e: span.e }).then(function (t) {
        var tbl = t.reportData.report.table, entries = (tbl && (tbl.data || tbl).entries) || [];
        var done = {};
        entries.forEach(function (x) { done[x.id] = x.total || 0; });
        rep.healers = rep.masterData.actors.filter(function (a) { return a.type === "Player" && HEALER_CLASSES[a.subType]; })
          .map(function (a) { return { id: a.id, name: a.name, server: a.server, cls: a.subType, healing: done[a.id] || 0 }; })
          .filter(function (h) { return h.healing > 0; })
          .sort(function (a, b) { return b.healing - a.healing; });
        return rep;
      });
    });
  }

  // every event involving one healer (and their pets/totems), page by page; onPage(count) for progress
  function loadEvents(rep, actorId, onPage) {
    var pets = rep.masterData.actors.filter(function (a) { return a.petOwner === actorId; }).map(function (a) { return a.id; });
    var ids = [actorId].concat(pets).join(",");
    var filter = "source.id in (" + ids + ") or target.id = " + actorId;
    var end = rep.endTime - rep.startTime, all = [];
    function page(s) {
      return gql(EVENTS_Q, { code: rep.code, s: s, e: end, f: filter }).then(function (d) {
        var ev = d.reportData.report.events;
        all = all.concat(ev.data || []);
        if (onPage) onPage(all.length, ev.nextPageTimestamp, end);
        return ev.nextPageTimestamp ? page(ev.nextPageTimestamp) : all;
      });
    }
    return page(0);
  }

  // ------------------------------------------------------------------ adapter: API events -> analyser events
  function feed(an, rep, events) {
    var actors = {}, ab = {};
    rep.masterData.actors.forEach(function (a) { actors[a.id] = a; });
    rep.masterData.abilities.forEach(function (a) { ab[a.gameID] = a.name; });
    function guid(id) {
      var a = actors[id];
      if (!a) return "Unknown-" + id;
      return (a.type === "Player" ? "Player-" : a.type === "Pet" ? "Pet-" : "Creature-") + id;
    }
    function nm(id) { var a = actors[id]; return a ? a.name + (a.server ? "-" + a.server : "") : ""; }
    rep.masterData.actors.forEach(function (a) { if (a.petOwner) an.owner[guid(a.id)] = "Player-" + a.petOwner; });
    var T0 = rep.startTime;
    // encounter boundaries, interleaved by time
    var marks = [];
    rep.fights.forEach(function (f) {
      if (!f.encounterID) return;
      marks.push({ ts: f.startTime, E: { type: "encStart", name: f.name } });
      marks.push({ ts: f.endTime, E: { type: "encEnd", kill: f.kill === true ? true : f.kill === false ? false : null }, end: true });
    });
    marks.sort(function (a, b) { return a.ts - b.ts || (a.end ? -1 : 1); });
    var mi = 0;
    function flushMarks(ts) {
      while (mi < marks.length && marks[mi].ts <= ts) { var m = marks[mi++]; m.E.t = (T0 + m.ts) / 1000; an.event(m.E); }
    }
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      flushMarks(e.timestamp);
      var E = convert(e, guid, nm, ab, T0);
      if (E) an.event(E);
    }
    flushMarks(Infinity);
    return an;
  }

  function convert(e, guid, nm, ab, T0) {
    var E = { t: (T0 + e.timestamp) / 1000, type: "other", src: guid(e.sourceID), srcName: nm(e.sourceID), dst: guid(e.targetID),
              sid: String(e.abilityGameID || ""), spell: ab[e.abilityGameID] || String(e.abilityGameID || "") };
    var resUnit = e.resourceActor === 2 ? E.dst : E.src;
    var mana = (e.classResources || []).filter(function (r) { return r.type === 0; })[0];
    if (mana) E.adv = { unit: resUnit, mana: mana.amount, max: mana.max };
    switch (e.type) {
      case "heal":
        E.type = "heal"; E.periodic = !!e.tick;
        E.over = e.overheal || 0; E.amount = (e.amount || 0) + E.over + (e.absorbed || 0);
        E.crit = e.hitType === 2;
        if (e.resourceActor === 2 && e.maxHitPoints) { E.hp = e.hitPoints; E.maxHp = e.maxHitPoints; } else { E.hp = 0; E.maxHp = 0; }
        break;
      case "cast":
        E.type = "cast"; E.cost = mana && mana.cost != null ? mana.cost : 0;
        break;
      case "resourcechange":
        E.type = "energize"; E.ptype = String(e.resourceChangeType); E.amount = e.resourceChange || 0; E.over = e.waste || 0;
        break;
      case "death": E.type = "death"; break;
      case "summon": E.type = "summon"; break;
      case "combatantinfo":
        E.type = "info";
        E.stats = { str: e.strength, agi: e.agility, sta: e.stamina, int: e.intellect, spi: e.spirit };
        break;
      default:
        if (!E.adv) return null;
    }
    return E;
  }

  var api = { reportCode: reportCode, fightFromUrl: fightFromUrl, signIn: signIn, completeSignIn: completeSignIn, signOut: signOut,
              signedIn: function () { return !!token(); }, configured: function () { return !!CLIENT_ID; },
              loadReport: loadReport, loadEvents: loadEvents, feed: feed, convert: convert, SITE: SITE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ForeverWCL = api;
})(this);
