"""Build docs/procs.js: healer-relevant on-use and proc effects on items (and the Insight weapon enchant), with
durations, cooldowns, proc chances and internal cooldowns read from the Forever client (SpellMisc / SpellDuration /
SpellAuraOptions / ItemEffect). The model for each effect (what it does to a healer) is set by hand below; docs/bags.js
(procValue) turns it into +healing from the player's own log (cast rates, healing per +1 healing, crit value per spell,
healing per mana).

Kinds (all values per use / per proc):
  buff      s = [healing, crit rating, Int, Spirit, MP5] for dur sec, every cd sec (on-use)
  mana      mana restored per use
  costCut   mana cost of every spell reduced by `per` for dur sec
  costPct   mana cost of healing spells -pct% for dur sec (and heal: +% healing, e.g. Natural Alignment Crystal)
  critUntil +pct% crit for dur sec or until the next non-periodic crit
  decay     healing bonus `start`, -`step` after each cast, for dur sec
  ramp      +`per` healing per cast already made, up to `max` stacks, `n` casts
  charges   +`heal` healing on the next `n` casts within dur
  heal      heals `amount` x `targets` per use
  absorb    shields = pct% of healing done for dur sec
  proc      chance% per cast (spells: only those) -> s (or spiPct: +% Spirit) for dur sec, internal cooldown icd
  spellCost pct% off the mana cost of the named spells
  spellMana mana back per cast of the named spells
  spellCrit +pct% crit on the named spells
  none      shown, not scored (note says why)
"""
import json, os, sys
from collections import defaultdict
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
import _items

BUILD = sys.argv[1] if len(sys.argv) > 1 else "1.60.1.70959"
R = lambda t: _items._rd(BUILD, t)

BIG = ["Greater Heal", "Healing Touch", "Healing Wave", "Holy Light"]
# item id: (effect spell, model)
SPEC = {
    # on-use stat buffs
    18820: (23271, dict(kind="buff", s=[175, 0, 0, 0, 0])),           # Talisman of Ephemeral Power
    20636: (24998, dict(kind="buff", s=[350, 0, 0, 0, 0])),           # Hibernation Crystal
    23046: (28779, dict(kind="buff", s=[130, 0, 0, 0, 0])),           # The Restrained Essence of Sapphiron
    272439: (1291103, dict(kind="buff", s=[0, 0, 0, 72, 0])),         # Serenity Field
    19952: (24498, dict(kind="buff", s=[0, 140, 0, 0, 0])),           # Gri'lek's Charm of Valor (+10% spell crit)
    13937: (18264, dict(kind="buff", s=[0, 0, 20, 0, 0], note="also +20 Intellect for the party (not counted)")),
    13143: (17252, dict(kind="buff", s=[0, 0, 0, 0, 22], note="only while its 500-damage shield holds: an upper bound")),
    272438: (1291101, dict(kind="critUntil", pct=5)),                 # Weakness Analyzer
    19950: (24658, dict(kind="decay", start=408, step=34)),           # Zandalarian Hero Charm
    22678: (28200, dict(kind="ramp", per=75, max=5, n=6)),            # Talisman of Ascendance
    23047: (28780, dict(kind="charges", heal=450, n=5)),              # Eye of the Dead
    19344: (23734, dict(kind="costPct", pct=-20, heal=20, cls="Shaman")),  # Natural Alignment Crystal (+20% cost)
    19958: (24546, dict(kind="costPct", pct=5, note="the 40% faster Greater Heal is not counted")),
    19955: (24542, dict(kind="costPct", pct=5, note="the 40% faster Healing Touch is not counted")),
    21625: (26467, dict(kind="absorb", pct=15, note="counts every shield as used: an upper bound")),
    # mana on use
    14152: (18385, dict(kind="mana", mana=500)),
    23027: (28760, dict(kind="mana", mana=500)),
    7515: (9253, dict(kind="mana", mana=800)),
    7507: (9252, dict(kind="mana", mana=160)),
    7508: (9252, dict(kind="mana", mana=160)),
    4381: (18805, dict(kind="mana", mana=128)),
    18637: (23064, dict(kind="mana", mana=304)),
    11819: (15604, dict(kind="mana", mana=630, note="doubled in mountainous areas")),
    11808: (17447, dict(kind="mana", mana=790, note="costs as much health")),
    18371: (1302205, dict(kind="mana", mana=1250, then=dict(s=[0, 0, -60, 0, 0], dur=120), note="then -60 Intellect for 2 min")),
    20525: (24884, dict(kind="mana", mana=400)),
    15866: (19634, dict(kind="mana", mana=250)),
    11832: (15646, dict(kind="costCut", per=150)),                    # Burst of Knowledge
    940: (18820, dict(kind="costCut", per=200)),                      # Robes of Insight
    # heals on use
    1713: (1317424, dict(kind="heal", amount=720, targets=1)),        # Ankh of Life
    280065: (1315849, dict(kind="heal", amount=505, targets=2)),      # Behemoth Bones
    8346: (10577, dict(kind="heal", amount=400, targets=1)),          # Gauntlets of the Sea
    5323: (14053, dict(kind="heal", amount=150, targets=1)),          # Everglow Lantern
    # procs
    19288: (23688, dict(kind="proc", s=[0, 0, 0, 150, 0], aura=23684)),            # Darkmoon Card: Blue Dragon
    249473: (1249118, dict(kind="proc", s=[40, 0, 0, 0, 0], aura=1249119, spells=BIG, chance=100)),  # Dormant Heart
    # relics and other spell-specific effects
    272431: (1291076, dict(kind="spellCost", spells=["Healing Wave"], pct=5)),
    272436: (1291089, dict(kind="spellCost", spells=["Holy Light"], pct=5)),
    22345: (27797, dict(kind="spellCost", spells=["Riptide"], pct=5)),
    279248: (1306429, dict(kind="spellCrit", spells=["Holy Shock"], pct=6)),
    279249: (1306448, dict(kind="spellCrit", spells=["Lesser Healing Wave"], pct=4)),
    23004: (28847, dict(kind="spellMana", spells=["Healing Touch"], mana=25)),
    23005: (28849, dict(kind="spellMana", spells=["Lesser Healing Wave"], mana=10)),
    19609: (24436, dict(kind="spellMana", spells=["Healing Stream Totem", "Mana Spring Totem"], mana=20)),
    # shown but not scored
    22399: (27846, dict(kind="none", note="cast time, not scored")),
    228175: (449980, dict(kind="none", note="cast time, not scored")),
    272429: (1291075, dict(kind="none", note="Swiftmend cooldown, not scored")),
    279250: (1306488, dict(kind="none", note="Swiftmend cooldown, not scored")),
    274761: (1295272, dict(kind="none", note="summons a healer; its healing isn't in the client")),
    22268: (1318931, dict(kind="none", note="procs on harmful spells only")),
    18321: (1302190, dict(kind="none", note="procs on damaging spells only")),
    17780: (21978, dict(kind="none", note="procs on damaging spells only")),
    18483: (1302348, dict(kind="none", note="procs on wand hits")),
    4696: (1135, dict(kind="none", note="must stay seated while drinking",
                      text="Restores 1915 mana over 30 sec. Must remain seated while drinking.")),   # Wowhead Forever
}
# weapon enchant: Insight (SpellItemEnchantment 8216 -> 1248758 -> 1299796)
ENCHANTS = {"Enchant Weapon - Insight": (1248758, dict(kind="proc", spiPct=100, aura=1299796))}

txt = _items.spell_text(BUILD)
dur = {r["ID"]: int(r["Duration"]) for r in R("SpellDuration")}
misc = {r["SpellID"]: r for r in R("SpellMisc")}
ao = {r["SpellID"]: r for r in R("SpellAuraOptions")}
ie = {r["ID"]: r for r in R("ItemEffect")}
effects = defaultdict(list)
for r in R("ItemXItemEffect"):
    e = ie.get(r["ItemEffectID"])
    if e:
        effects[int(r["ItemID"])].append(e)


seff = defaultdict(dict)
for r in R("SpellEffect"):
    seff[r["SpellID"]][int(r["EffectIndex"])] = r


def secs(x):
    x = round(x)
    return f"{x // 60} min" if x >= 60 and x % 60 == 0 else f"{x} sec"


def clean(t, sid):
    """fill the client tooltip variables the generic substitution leaves: $d / $123d durations, $t1 periods, $o1 totals,
    $M1 / $m1 amounts, $a1 radius"""
    import re

    def eff(s_, i):
        return seff.get(str(s_), {}).get(int(i or 1) - 1)

    def sub(m):
        other, kind, i = m.group(1) or str(sid), m.group(2), m.group(3)
        e = eff(other, i)
        if kind == "d":
            d = sdur(other)
            return secs(d) if d else m.group(0)
        if not e:
            return m.group(0)
        bp, per = abs(float(e["EffectBasePointsF"] or 0)), int(e["EffectAuraPeriod"] or 0) / 1000
        if kind == "t":
            return "%g" % per
        if kind == "o":
            return "%g" % (bp * sdur(other) / per) if per else m.group(0)
        if kind in ("m", "M"):
            return "%g" % bp
        if kind == "a":
            return "nearby"
        return m.group(0)
    t = re.sub(r"\$\?s\d+\[[^\]]*\](?:\?s\d+\[[^\]]*\])*\[([^\]]*)\]", lambda m: m.group(1), t)  # class-conditional: generic text
    t = re.sub(r"\$(\d*)([dtomMa])(\d?)", sub, t)
    t = re.sub(r"\$\{(-?[\d.]+)/(-?[\d.]+)\}(?:\.\d)?", lambda m: "%g" % abs(float(m.group(1)) / float(m.group(2))), t)
    return t.replace(" every 1 sec", " every sec").replace("within nearby yards", "nearby")


def sdur(sid):
    m = misc.get(str(sid))
    d = dur.get(m["DurationIndex"]) if m else None
    return d / 1000 if d and d > 0 else 0


def fill(sid, m, item=None):
    m = dict(m)
    a = ao.get(str(sid))
    if m["kind"] == "proc":
        if "chance" not in m:
            m["chance"] = int(a["ProcChance"]) if a else 0
        m["icd"] = int(a["ProcCategoryRecovery"]) / 1000 if a else 0
        m["dur"] = sdur(m.pop("aura"))
    elif m["kind"] in ("buff", "critUntil", "decay", "ramp", "charges", "costPct", "costCut", "absorb", "mana"):
        if m["kind"] != "mana":
            m["dur"] = sdur(sid)
    if item is not None and m["kind"] not in ("proc", "spellCost", "spellMana", "spellCrit", "none"):
        cds = [int(e["CoolDownMSec"]) for e in effects[item] if e["SpellID"] == str(sid) and int(e["CoolDownMSec"]) > 0]
        if not cds:
            raise SystemExit(f"no cooldown for item {item} spell {sid}")
        m["cd"] = cds[0] / 1000
    m["text"] = m.get("text") or clean(txt(sid), sid)
    return m


# ------------------------------------------------------------------ set bonuses
# Passive stat bonuses are read from the client (aura 135 healing, 85 MP5, 29 Int / Spirit, 57 spell crit %, 189 crit
# rating); everything else a healer could use is modelled by hand below (same kinds as the items, keyed by bonus spell).
# Set membership: client ItemSparse.ItemSet, else wowtbc.gg's set_id (Forever's reworked Tier 0.5 pieces).
SET_SPEC = {
    450576: dict(kind="proc", mana=200, chance=5),                      # Devout / Virtuous: 5% on cast, 200 mana
    450608: dict(kind="proc", mana=200, chance=5, note="proc chance assumed 5% (the client stores 5; no tooltip value)"),
    450626: dict(kind="proc", s=[65, 0, 0, 0, 0], chance=4, aura=27775,
                 note="proc chance assumed 4%, as Classic's Five Thunders (the client says 100%, Wowhead gives none)"),
    27774: dict(kind="proc", s=[65, 0, 0, 0, 0], aura=27775),
    450625: dict(kind="proc", s=[65, 0, 0, 0, 0], chance=4, aura=27499, note="proc chance assumed 4%"),
    28802: dict(kind="proc", s=[0, 0, 0, 0, 24], aura=28804),           # Vestments of Faith 8pc: Epiphany
    1321587: dict(kind="procHeal", amount=200, chance=100, icd=2,
                  note="client: every heal, at most once per 2 sec; refreshes on the same target - an upper bound"),
    1321560: dict(kind="lowMana", mana=200, note="once per 5 min, when your mana drops below 15%"),
    21894: dict(kind="casting", pct=15),                                 # Green Dragon Mail 3pc
    28743: dict(kind="spellCost", spells=["Healing Touch", "Regrowth", "Rejuvenation", "Tranquility"], pct=3),
    28807: dict(kind="spellCost", spells=["Renew"], pct=12),
    28818: dict(kind="spellCost", spells=["Healing Stream Totem", "Mana Spring Totem", "Mana Tide Totem", "Windfury Totem",
                                          "Grace of Air Totem", "Strength of Earth Totem", "Tranquil Air Totem"], pct=12),
    28719: dict(kind="spellCritMana", spells=["Healing Touch"], pct=30),
    28809: dict(kind="spellCritHeal", spells=["Greater Heal"], amount=500, note="counts every shield as used: an upper bound"),
    26171: dict(kind="spellPct", spells=["Renew"], pct=20, note="+3 sec on a 15 sec Renew = +20% Renew healing"),
    1301703: dict(kind="none", note="cooldown, not scored"),
    1301713: dict(kind="none", note="cooldown, not scored"),
    26122: dict(kind="none", note="cast time, not scored"),
    24457: dict(kind="none", note="cast time, not scored"),
}
HEALER_MASK = 2 | 16 | 64 | 1024


def passive(sid):
    """[healing, crit rating, Int, Spirit, MP5] of a passive stat bonus, or None when it has none"""
    v, any_ = [0, 0, 0, 0, 0], False
    for e in seff.get(str(sid), {}).values():
        a, bp, mv = e["EffectAura"], float(e["EffectBasePointsF"] or 0), e["EffectMiscValue_0"]
        if a == "135": v[0] = max(v[0], bp); any_ = True
        elif a == "13" and mv == "126" and not v[0]: v[0] = bp; any_ = True     # spell power counts as healing
        elif a == "57": v[1] += bp * 14; any_ = True
        elif a == "189" and int(mv) & 1024: v[1] += bp; any_ = True
        elif a == "29" and mv == "3": v[2] += bp; any_ = True
        elif a == "29" and mv == "4": v[3] += bp; any_ = True
        elif a == "85" and mv == "0": v[4] += bp; any_ = True
    return [round(x) for x in v] if any_ and any(v) else None


def build_sets():
    wt = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "wowtbc_data", "forever_gear.json"), encoding="utf-8"))
    names = {r["ID"]: r["Name_lang"] for r in R("ItemSet")}
    bonus = defaultdict(list)
    for r in R("ItemSetSpell"):
        bonus[r["ItemSetID"]].append((int(r["Threshold"]), int(r["SpellID"])))
    members = defaultdict(list)
    for it in _items.all_items(BUILD):
        sid = it["set_id"] or (wt.get(str(it["id"])) or {}).get("set_id") or 0
        if sid and (it["allow"] in (0, -1) or it["allow"] & HEALER_MASK):
            members[str(sid)].append(it["id"])
    sets = {}
    for sid, ids in members.items():
        bs = []
        for k, sp in sorted(bonus.get(sid, [])):
            st = passive(sp)
            if sp in SET_SPEC:
                m = dict(SET_SPEC[sp])
                if m["kind"] == "proc":
                    a = ao.get(str(sp))
                    m.setdefault("chance", int(a["ProcChance"]) if a else 0)
                    m["icd"] = int(a["ProcCategoryRecovery"]) / 1000 if a else 0
                    m["dur"] = sdur(m.pop("aura")) if "aura" in m else 0
            elif st:
                m = dict(kind="stat", s=st)
            else:
                continue
            m["k"] = k
            m["text"] = clean(txt(sp), sp)
            bs.append(m)
        if any(b["kind"] != "none" for b in bs):
            sets[sid] = dict(n=names.get(sid, ""), items=sorted(set(ids)), b=bs)
    return sets


out = {"items": {}, "enchants": {}, "sets": build_sets()}
for iid, (sid, m) in SPEC.items():
    if not any(e["SpellID"] == str(sid) for e in effects[iid]):
        raise SystemExit(f"item {iid} has no effect spell {sid}")
    out["items"][str(iid)] = fill(sid, m, iid)
for n, (sid, m) in ENCHANTS.items():
    out["enchants"][n] = fill(sid, m)
dst = os.path.join(os.path.dirname(__file__), "..", "docs", "procs.js")
with open(dst, "w", encoding="utf-8") as fh:
    fh.write("// Generated by tools/gen_procs.py - do not edit. On-use and proc effects a healer can use; durations, cooldowns,\n"
             "// proc chances and internal cooldowns from the Forever client " + BUILD + ".\n")
    fh.write("var FOREVER_PROCS = " + json.dumps(out, separators=(",", ":"), ensure_ascii=False) + ";\n")
    fh.write("if (typeof module !== 'undefined') module.exports = FOREVER_PROCS;\n")
print(len(out["items"]), "items,", len(out["enchants"]), "enchants,", len(out["sets"]), "sets")
for k, v in list(out["items"].items())[:3] + list(out["enchants"].items()):
    print(k, {x: y for x, y in v.items() if x != "text"})
