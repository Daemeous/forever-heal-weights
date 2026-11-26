#!/usr/bin/env node
// node tools/cli.js <WoWCombatLog.txt> [more logs...] [--player Name] [--bonus 500] [--json out.json]
const fs = require("fs"), path = require("path"), readline = require("readline");
const W = require(path.join(__dirname, "..", "docs", "engine.js"));
const SPELLS = require(path.join(__dirname, "..", "docs", "spells.js"));
const TALENTS = require(path.join(__dirname, "..", "docs", "talents.js"));
const args = process.argv.slice(2), files = [], opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) opt[args[i].slice(2)] = args[++i]; else files.push(args[i]);
}
if (!files.length) { console.error("usage: node tools/cli.js <WoWCombatLog.txt> [--player Name] [--bonus N (default: worked out from the log)] [--json out.json]"); process.exit(1); }
(async () => {
  const an = new W.Analyzer(SPELLS, TALENTS);
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) an.line(line);
  }
  an.finish();
  const hs = W.healers(an);
  console.log("Healers:", hs.map(h => `${h.name} (${h.cls}, ${Math.round(h.eff)})`).join("; "));
  const pick = opt.player ? hs.filter(h => h.name.toLowerCase().startsWith(opt.player.toLowerCase())) : hs.slice(0, 1);
  const all = {};
  for (const h of pick) {
    const o = W.defaults(h.cls), det = W.detect(an, h.guid, TALENTS);
    if (det.talents.length) Object.assign(o, det.inputs);
    if (det.bonus) o.bonus = det.bonus.value;
    console.log(`
${h.name}: talents ${det.talents.map(t => t.name + " " + t.rank + "/" + t.max).join(", ") || "(none read)"}; ` +
      `bonus healing ${det.bonus ? det.bonus.value + " (" + det.bonus.lo + ".." + det.bonus.hi + ")" : "not estimated"}`);
    for (const k of ["bonus", "regen", "casting", "sg", "intBonus", "critPerInt"]) if (opt[k] != null) o[k] = +opt[k];
    const r = W.analyse(an, h.guid, o); all[h.name] = r;
    const f = (x) => x.toFixed(2);
    const show = (r) => r.throughput && console.log(`${r.label.padEnd(30)} ${(r.kill === false ? "wipe" : "").padEnd(5)}${Math.round(r.duration).toString().padStart(5)}s eff ${Math.round(r.eff).toString().padStart(7)} over ${(100 * r.overPct).toFixed(0).padStart(3)}% HPM ${r.hpm.toFixed(2).padStart(5)} minMana ${(100 * r.minMana).toFixed(0).padStart(3)}% | thr crit ${f(r.throughput.critRating)} int ${f(r.throughput.intellect)} spi ${f(r.throughput.spirit)} | mana crit ${f(r.manaLimited.critRating)} int ${f(r.manaLimited.intellect)} spi ${f(r.manaLimited.spirit)} mp5 ${f(r.manaLimited.mp5)}`);
    console.log(`\n== ${h.name} (${h.cls}) bonus healing ${o.bonus}; heal per +1 healing (whole log) ${r.whole.healPerPoint.toFixed(0)}`);
    show(r.whole); if (r.bosses) show(r.bosses); show(r.trash);
    for (const e of r.encounters) show(e);
    const fi = W.fightInputs(an, h.guid);
    console.log(`
Boss fight estimates (max mana ${fi.maxMana}, Spirit ${fi.spirit}, gear MP5 0):`);
    for (const fr of W.fights(r, o, [[120, 1800], [180, 1800], [360, 3600]].map(([L, other]) => Object.assign({ seconds: L, other }, fi))))
      console.log(`${fr.label.padEnd(30)} mana ${Math.round(fr.mana)} need ${Math.round(fr.need)} funded ${(100 * fr.funded).toFixed(0)}% | crit ${f(fr.manaLimited.critRating)} (${f(fr.manaLimited.critPct)}/1%) int ${f(fr.manaLimited.intellect)} spi ${f(fr.manaLimited.spirit)} mp5 ${f(fr.manaLimited.mp5)}`);
  }
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(all, null, 1));
})();
