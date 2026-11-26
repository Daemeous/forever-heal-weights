// Dev test: turn a raw log into Warcraft-Logs-shaped API events for one player, run them through docs/wcl.js and
// check the results match the raw-log path. Usage: node tools/wcl_roundtrip.js <WoWCombatLog.txt> <Player-GUID>
const fs=require('fs'),R=require('path').join(__dirname,'..','docs')+'/';
const W=require(R+'engine.js'),S=require(R+'spells.js'),C=require(R+'wcl.js');
const F=process.argv[2];
const G=process.argv[3];
// raw path, but only lines involving G (same data the API filter returns) + encounters
const a1=new W.Analyzer(S); const events=[]; const ids={}, actors=[]; const ab={};
let T0=null; const fights=[]; let open=null;
function id(g,name){ if(!(g in ids)){ids[g]=actors.length+1; actors.push({id:ids[g],name:(name||g).split('-')[0],server:(name||'').split('-')[1]||null,type:g.startsWith('Player-')?'Player':'NPC',subType:'Priest',petOwner:null});} return ids[g]; }
for (const line of fs.readFileSync(F,'utf8').split('\n')) {
  const sp=line.indexOf('  '); if(sp<0) continue;
  const enc=line.includes('ENCOUNTER_');
  if(!enc && !line.includes(G)) continue;
  // capture normalised event by intercepting event()
  let cap=null; const orig=a1.event; a1.event=function(E){cap=E; return orig.call(this,E);}; a1.line(line); a1.event=orig;
  if(!cap) continue;
  if(T0==null) T0=Math.round(cap.t*1000);
  const ts=Math.round(cap.t*1000)-T0;
  if(cap.type==='encStart'){open={id:fights.length+1,name:cap.name,startTime:ts,encounterID:1}; continue;}
  if(cap.type==='encEnd'){ if(open){open.endTime=ts;open.kill=cap.kill;fights.push(open);open=null;} continue;}
  const e={timestamp:ts,sourceID:id(cap.src,cap.srcName),targetID:id(cap.dst),abilityGameID:+cap.sid}; ab[cap.sid]=cap.spell;
  if(cap.adv){ e.resourceActor = cap.adv.unit===cap.src?1:2; e.classResources=[{type:0,amount:cap.adv.mana,max:cap.adv.max}]; id(cap.adv.unit); }
  if(cap.type==='heal'){Object.assign(e,{type:'heal',amount:cap.amount-cap.over,overheal:cap.over,hitType:cap.crit?2:1,tick:cap.periodic||undefined}); if(cap.maxHp){e.resourceActor=2;e.hitPoints=cap.hp;e.maxHitPoints=cap.maxHp;}}
  else if(cap.type==='cast'){e.type='cast'; if(e.classResources) e.classResources[0].cost=cap.cost;}
  else if(cap.type==='energize'){Object.assign(e,{type:'resourcechange',resourceChange:cap.amount,waste:cap.over,resourceChangeType:+cap.ptype});}
  else if(cap.type==='death') e.type='death'; else if(cap.type==='summon') e.type='summon';
  else if(cap.type==='info'){Object.assign(e,{type:'combatantinfo',intellect:cap.stats.int,spirit:cap.stats.spi});}
  else e.type='damage';
  events.push(e);
}
a1.finish();
const rep={code:'x',startTime:T0,endTime:T0+events[events.length-1].timestamp,fights,masterData:{actors,abilities:Object.entries(ab).map(([g,n])=>({gameID:+g,name:n}))}};
const a2=C.feed(new W.Analyzer(S),rep,events).finish();
const g2='Player-'+ids[G];
const o=W.defaults('Priest'); o.bonus=405;
const r1=W.analyse(a1,G,o), r2=W.analyse(a2,g2,o);
for (const k of ['whole','bosses']) console.log(k, ['eff','spent','hpm','critRate','tIn','tOut','healPerPoint'].map(x=>x+' '+r1[k][x].toFixed(2)+' / '+r2[k][x].toFixed(2)).join(' | '));
console.log('encounters',r1.encounters.length,r2.encounters.length, 'thr int', r1.bosses.throughput.intellect.toFixed(3), r2.bosses.throughput.intellect.toFixed(3));
