# Forever Healer Stat Weights

Stat weights for **WoW Forever** healers (Priest, Paladin, Shaman, Druid), worked out from your own combat log,
for every boss encounter in it.

**Use it:** open the GitHub Pages site for this repository, then drop your `WoWCombatLog-*.txt` on it.
The log is read by your own browser. Nothing is uploaded anywhere.

**Offline:** download the repository and open `docs/index.html`. It works straight from disk.

## What you get

- Weights relative to +1 bonus healing for crit rating, Intellect, Spirit and MP5. They come for the whole log,
  all boss fights together, trash, and each encounter.
- Two views:
  - **Throughput**: mana is free. This tells you what makes your heals bigger.
  - **Mana-limited**: each point of mana is worth your healing per mana in boss fights.
- A CSV export.

**Warcraft Logs link** (the second tab): paste a `forever.warcraftlogs.com` report link and sign in to Warcraft
Logs once. The page then reads the report through the Warcraft Logs API, still in your browser.

## Setting up the Warcraft Logs option (once, for whoever hosts the page)

1. Go to https://www.warcraftlogs.com/api/clients/ and create a client:
   - Name: anything.
   - Redirect URL: the page's exact address, e.g. `https://daemeous.github.io/forever-heal-weights/`.
   - Tick **Public Client**. This uses PKCE, so there is no secret to keep.
2. Put the client ID in `docs/wcl-config.js` and push.

The API returns events already parsed, not raw log lines. `docs/wcl.js` converts them into the same events the
raw-log reader produces. `node tools/wcl_roundtrip.js <log> <Player-GUID>` checks that conversion against a raw log.
The API's real field layout (resource actor, hit points, cast cost) has not yet been checked against a live report.

## Before you start

- Turn on **Advanced Combat Logging** (System > Network) and type `/combatlog` before the run.
  The log ends up in `World of Warcraft\_forever_\Logs\`.
- Enter your **Bonus Healing** from the character sheet, with the gear you wore in the log. This input matters most.
  Then check the talent inputs (Int %, Spiritual Guidance, regen while casting).

## Method (short)

- **+1 bonus healing**: summed over every heal that did not overheal. Each heal counts its spell's coefficient
  (Forever client data) times your talent multiplier, measured from your own non-crit heals, times the downrank
  penalty. Crits count x1.5.
- **+1% crit**:
  - A non-crit that didn't overheal gains half its size, capped at the target's missing health.
  - A crit gains only the part of its crit bonus that wasn't overheal.
  - Water Shield / Illumination mana counts in the mana-limited view.
  - 14 crit rating = 1%.
- **Intellect**: its crit (about 0.0168% per point), plus 15 mana per point for each time you drained your mana from
  full to under 10% (mana-limited view).
- **Spirit / MP5**: regen only counts while you were below full mana, split into inside and outside the
  five-second rule. Druid Bloom heals for your Spirit.
- **Real mana costs**: the log shows the cost before talents. The real cost is measured from your mana bar right
  after each cast.
- **Downranking (Forever rule, community-measured)**: a rank keeps its full coefficient for 17 levels after its
  learn level, then loses 5% per level. Logs show a floor of about 10%.

Assumptions you may want to check:
- Regen formulas are Classic. The Priest one (13 + Spirit/4 per tick) is confirmed in Forever.
- Swiftmend and Earth Shield get no bonus-healing credit.
- Absorbs (Power Word: Shield) are not counted as healing.

## Command line

```
node tools/cli.js WoWCombatLog-112426_134059.txt --player Name --bonus 450 [--json out.json]
```

## Updating the spell data

`docs/spells.js` is generated from the Forever client DB2 tables (wago.tools, product `wowf`) by
`tools/gen_spells.py`. That script needs the table cache from the parent workbook project.

Not affiliated with Blizzard Entertainment.
