/* Materialise the case study to data/*.csv.
   This is what makes the data path REAL rather than described: the app no
   longer holds its own numbers, it fetches these files through the server,
   scoped to the signed-in account. Replace them with a genuine CRM export
   and nothing else changes. */
import { writeFileSync, mkdirSync } from 'fs';
import { CLIENTS, AGENTS, APPTS, LEADS } from '../js/casestudy.js';

const pad = (n) => String(n).padStart(2, '0');
const d = (ms) => { const x = new Date(ms); return x.getFullYear()+'-'+pad(x.getMonth()+1)+'-'+pad(x.getDate()); };
const hm = (m) => pad(Math.floor(m/60))+':'+pad(m%60);
const cell = (v) => { const s = v==null?'':String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
const csv = (headers, rows) => [headers.join(',')]
  .concat(rows.map(r => headers.map(h => cell(r[h])).join(','))).join('\r\n') + '\r\n';

mkdirSync('data', { recursive: true });

writeFileSync('data/clients.csv', csv(
  ['id','name','vertical','status','flag','mrr','perappt','since','seats','csm','churnedon','churnreason'],
  CLIENTS.map(c => ({ id:c.id, name:c.name, vertical:c.vertical, status:c.status, flag:c.flag||'',
    mrr:c.mrr, perappt:c.perAppt, since:c.since, seats:c.seats, csm:c.csm,
    churnedon:c.churnedOn||'', churnreason:c.churnReason||'' }))));

writeFileSync('data/agents.csv', csv(
  ['id','name','kind','clientid','startedat','endedat','base','seatcost','active'],
  AGENTS.map(a => ({ id:a.id, name:a.name, kind:a.kind, clientid:a.clientId,
    startedat:d(a.startedAt), endedat:a.endedAt?d(a.endedAt):'',
    base:a.base, seatcost:a.seatCost, active:String(a.active) }))));

writeFileSync('data/appointments.csv', csv(
  ['date','time','clientid','agentid','outcome','value'],
  APPTS.map(a => ({ date:d(a.t), time:hm(a.hm), clientid:a.clientId,
    agentid:a.agentId, outcome:a.outcome, value:a.value }))));

writeFileSync('data/leads.csv', csv(
  ['id','name','clientid','stage','source','value','score','date'],
  LEADS.map(l => ({ id:l.id, name:l.name, clientid:l.clientId, stage:l.stage,
    source:l.source, value:l.value, score:l.score, date:d(l.t) }))));

console.log('wrote data/:');
console.log('  clients.csv     ', CLIENTS.length);
console.log('  agents.csv      ', AGENTS.length);
console.log('  appointments.csv', APPTS.length);
console.log('  leads.csv       ', LEADS.length);
