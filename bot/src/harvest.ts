/* bot :: harvest ("жатва")
   First preset. The score is minutes, minutes are coverage of burning needles
   (rules 8.1-8.3), and the cheapest coverage in the valley is a free ruin: a
   Tkach standing on it takes it in 8 ticks for no energy at all, while building
   the same needle costs 60 energy and the same 8 ticks on top of the walk.
   So the plan is: take every ruin the thread can still hold, buy a lot when the
   energy is there (two ruins for 60-137 and no walk at all), take the contract
   when it lands near us (30 minutes is a whole needle's worth of match), feed
   the outermost needle when there is nothing left to take, and at dawn step
   into the Keeper's ring, where a needle pulls twice (rule 22.4).

   Three things the world punishes and this head therefore watches:

   - the channel. 96 bytes of floor plus the needles' share (rule 13.2), 32 for
     a command and 32 per acting machine per tick (13.6), and hands are paid
     after commands from the same scale (13.7). Two commands in a tight tick
     take the hands away from two machines, so commands are rationed and issued
     only when a machine's state actually changed.
   - the turn refusal. Any command to a machine that has begun a step comes back
     `поворот` (10.6), and a frame whose every command is refused is a silent
     tick (23.2). So a machine is never commanded mid-step (`midStep`).
   - the Keeper. Heating or building inside his border provokes a ram (21.6),
     but walking and standing there do not (21.7). Nothing inside the border is
     targeted before dawn; the staging cell is next to the ring, never on it. */

import { BlankBot } from '@zoria/sdk';
import { RulesOracle } from '@zoria/sdk';
import { createEngine } from '@zoria/engine';
import { decodeVerdicts } from '@zoria/protocol';
import type { ActorName, ClsName, Hex, MineUnit, Observe, Order, OrderKind, SlotName } from '@zoria/protocol';
import { dist, hexDist, key, ring, same, Valley } from './valley.js';

/* Refusal codes that mean "this cell will not do", from the protocol table
   (04-protocol.md, 6.6): impassable ground, no path, refusal without a word. */
const DENY_GARBAGE = 1;
const DENY_LAND = 11;
const DENY_PATH = 12;
const DENY_OTHER = 21;

type PlanKind = 'take' | 'feed' | 'build' | 'stage' | 'jam' | 'ram';

interface Plan {
  readonly kind: PlanKind;
  readonly at: Hex;
  readonly key: string;
  readonly since: number;
  /** For `ram`: the foe machine chased (rule 11.6 names a machine, not a cell). */
  readonly target?: string;
}

/** Tunables of this preset. Named so that an experiment is an edit of one line. */
export interface HarvestDials {
  /** Tkachi to keep on the field; the swarm ceiling is 8 weight, a Tkach is 2. */
  readonly tkachi: number;
  /** Commands per tick besides the free keepalive. */
  readonly cmds: number;
  /** Silence margin: a command is forced when this many ticks passed without an accepted one.
      The verdict of a tick lands after that tick's frame, so the run the head sees is one tick
      behind the node's; 4 measured a run of 5 in the tournament, one refusal short of losing
      the slot at 6 (23.2). */
  readonly quiet: number;
  /** Bid for a lot; second price, so this is a ceiling, not a cost (rule 17.5). */
  readonly bid: number;
  /** Keep this much energy on top of a needle's price before building for growth. */
  readonly buildSpare: number;
  /** Above this much energy the regen outruns every other use: build first, walk second. */
  readonly flood: number;
  /** Least land price a new needle must add to be worth 60 energy. */
  readonly buildGate: number;
  /** Ticks before dawn to send one Tkach to the ring's doorstep. */
  readonly stage: number;
  /** Do not walk farther than this for a ruin. */
  readonly reach: number;
  /** Ticks a cell stays set aside after the node refused to walk there. */
  readonly forget: number;
  /** Klinki to keep for jamming; each is one weight out of the Tkachi's eight. */
  readonly klinoks: number;
  /** A Klinok is only worth its channel once the tick budget reaches this. */
  readonly jamChan: number;
  /** 1 - Klinki guard instead of jamming: ram a foe Tkach standing on a needle of
      ours. It is heating it (9.2), and a ram on a working Tkach is clean (11.7):
      the Klinok lives, the needle stays, the rival loses a Tkach. */
  readonly guard: number;
  /** Ticks a Tkach may stand short of its target before the plan is dropped and the
      target set aside; 0 - never. The node's path does not know bodies (SDK 3, 10.4):
      a parked foe on the path blocks the step, the node drops the task after a few
      ticks, the same `move` lays the same path, and the Tkach waits again - a third
      of all Tkach time against the sample charters went to plans older than 120 ticks. */
  readonly stall: number;
}

/* Three Tkachi and a guard Klinok (weight 7 of 8), measured 03.10 on three seed
   sets of 15 packs: 360 shares of 405 against 321 with four Tkachi and no guard.
   Dropping a walk stalled for 20 ticks: 375 against 360, every set up, the held-out
   one too (04.10). A second guard Klinok: 234 against 238 - not taken. */
export const DIALS: HarvestDials = {
  tkachi: 3,
  cmds: 2,
  quiet: 3,
  bid: 137,
  buildSpare: 0,
  flood: 200,
  buildGate: 16,
  stage: 60,
  reach: 12,
  forget: 30,
  klinoks: 1,
  jamChan: 220,
  guard: 1,
  stall: 20,
};

/** Has the machine begun a step? Rule 10.6 names both halves: a non-empty path
    and `wait` above zero. `wait` alone is not it: the node keeps the last step's
    count on a machine that walked to its cell and stopped, so a Tkach that took a
    ruin stands on it with no task and `wait` still set. Reading `wait` alone left
    such a Tkach unplanned - 4355 of 4664 idle Tkach-ticks over three packs. */
export function midStep(u: MineUnit): boolean {
  return u.wait > 0 && u.task !== null && u.task.path > 0;
}

export class HarvestBot extends BlankBot {
  private valley: Valley | null = null;
  private oracle: RulesOracle | null = null;
  private hearth: Hex = { q: 0, r: 0 };
  private seatFixed = false;

  /** Believed owner of every needle cell: manifest priors, then sight and events. */
  private readonly owner = new Map<string, ActorName | null>();
  /** Whether a needle was silent when last seen: a dark needle gives no loot (8.7). */
  private readonly dark = new Map<string, boolean>();
  private readonly capAt = new Map<string, number>();
  /** Last tick a jam was seen on one of our needles: a jam is not a cut thread. */
  private readonly jamAt = new Map<string, number>();
  private readonly plans = new Map<string, Plan>();
  private readonly bidden = new Set<number>();
  private readonly badSite = new Set<string>();
  /** Cells a move was refused for, with the tick of the refusal. */
  private readonly badGoal = new Map<string, number>();
  /** Where each machine stands and since which tick: the stall check reads it. */
  private readonly still = new Map<string, { at: string; since: number }>();
  /** Машины на сотах этого такта: сота -> имя машины. Чистится каждый такт. */
  private readonly bodies = new Map<string, string>();

  /** Plans started and money spent, for the sparring script: where the four Tkachi went.
      `silent` is the longest run of silent ticks (23.2): the charter takes the slot at 6, so
      this number answers P2-04 without a thirty-minute run at match tempo. `sent` and `nacks`
      count what the gatekeeper did with the frames - a tick of refusals only is silence too. */
  readonly stat = { take: 0, build: 0, feed: 0, stage: 0, jam: 0, ram: 0, stall: 0, yard: 0, bid: 0, quiet: 0, sent: 0, orders: 0, nacks: 0, garbage: 0, silent: 0 };
  /** Отказы по кодам протокола: код -> сколько раз (04-protocol.md, 6.6). */
  readonly denyBy = new Map<string, number>();

  private t = 0;
  /** What each command of the last frame was about, so a verdict can be acted on. */
  private lastCmd: ({ kind: OrderKind; unit?: string; site?: string; goal?: string; yard?: ClsName } | null)[] = [];
  /** Corpses ordered but not yet out of the yard: the frame does not show them (SDK 2). */
  private readonly pending: Record<ClsName, number> = { ткач: 0, клинок: 0 };
  private yardAt = -999;
  private reserve = 0;
  private lastOk = 0;
  /** Tick before the first one this head saw; -1 until it has seen any. */
  private joined = -1;
  private focus: Hex | null = null;
  private focusAt = -999;
  private anchors: Hex[] = [];

  constructor(private readonly dials: HarvestDials = DIALS) {
    super();
  }

  override init(manifestBytes: Uint8Array, slot: SlotName): void {
    super.init(manifestBytes, slot);
    /* `BlankBot.init` сам кидает «the manifest did not parse» на нечитаемых
       байтах, так что сюда с пустым маніфестом не попасть; проверка стоит
       ради типа, и мутант в ней неубиваем по построению. Проверка на отказ
       есть — она держит поведение SDK, а не эту строку. */
    const m = this.manifest;
    if (!m) throw new Error('manifest did not decode');
    const v = new Valley(m);
    this.valley = v;
    /* The oracle is the node's own engine: paths, link range, cliffs and storms
       answered by the code that will judge them (SDK 4). A hash other than ours
       throws here, and connectBot turns that into a refusal to play. */
    this.oracle = new RulesOracle(createEngine, manifestBytes);
    this.hearth = v.seat(slot);
    for (const [k, spec] of v.needles) {
      this.owner.set(k, spec.ring || spec.spoke ? 'K' : spec.start);
    }
  }

  protected override think(obs: Observe): Order[] {
    const v = this.valley;
    const o = this.oracle;
    if (!v || !o) return [];

    this.t = obs.t;
    this.fixSeat(obs);
    this.sync(obs, v);
    this.anchors = this.litAnchors(obs);
    /* every tick and for every machine: unitOrder is not called for all of them */
    for (const u of obs.mine.units) {
      const at = key(u.q, u.r);
      if (this.still.get(u.id)?.at !== at) this.still.set(u.id, { at, since: obs.t });
    }

    const out: Order[] = [];
    const chanAt = obs.pulse.chanAt;
    const tick = this.dials;

    /* Hands first: every acting machine costs 32 bytes of the same scale the
       commands are paid from, so the command budget is what is left over. A jam
       we hold takes its own 8 bytes a tick on top of the hands (11.1). */
    const hands =
      obs.mine.units.filter((u) => this.acting(u, v)).length * v.num.chanTick + obs.mine.jams.length * v.num.jamKeep;
    const cost = v.num.chanOrder;
    let room = Math.max(0, Math.floor((chanAt - hands) / cost));
    room = Math.min(room, tick.cmds);

    const yard = this.yardOrder(obs, v);
    if (yard) {
      out.push(yard);
      room = Math.max(0, room - 1);
    }

    /* The envelope is counted spent only when the command actually goes out:
       a bid dropped for lack of channel would otherwise be a lot never bid on. */
    const bid = this.bidOrder(obs, v, o);
    if (bid && room > 0) {
      this.bidden.add(bid.lot);
      out.push(bid);
      room--;
    }

    for (const u of obs.mine.units) {
      if (room <= 0) break;
      const order = this.unitOrder(u, obs, v, o);
      if (order) {
        out.push(order);
        room--;
      }
    }

    const watch = this.watchOrder(obs, v, room);
    if (watch) out.push(watch);

    if (out.length === 0) {
      const keep = this.keepAlive(obs, v);
      if (keep) out.push(keep);
    }

    /* The silence run is measured from the last accepted command, which is what
       the node counts too: an empty frame and a frame of refusals are the same
       thing to it (23.2). The verdict of this tick lands in feedback(), after
       this frame, so the run is read one tick late and never short. It is counted
       from the tick this head joined, not from zero: a head that came back after
       a break (04-protocol.md, 8) starts at tick 600 with nothing accepted yet,
       and 600 ticks of silence would be a lie about the slot. */
    if (out.length) this.stat.sent++;
    this.stat.orders += out.length; // знаменатель доли отказов K3
    if (this.joined < 0) this.joined = obs.t - 1;
    this.stat.silent = Math.max(this.stat.silent, obs.t - Math.max(this.lastOk, this.joined));

    this.lastCmd = out.map((c) =>
      c.kind === 'needle'
        ? { kind: c.kind, unit: c.unit, site: key(c.q, c.r) }
        : c.kind === 'move'
          ? { kind: c.kind, unit: c.unit, goal: key(c.q, c.r) }
          : c.kind === 'feed'
            ? { kind: c.kind, unit: c.unit }
            : c.kind === 'yard'
              ? { kind: c.kind, yard: c.cls }
              : { kind: c.kind },
    );
    return out;
  }

  /** Короткая сводка головы для строки конца партии.
      `run.stats.orders` проводу — это кадры (по одному на такт), а лестница К3
      считает **команды** (оценивание 8.5), поэтому знаменатель берётся свой. */
  report(): string {
    const share = this.stat.orders ? ((this.stat.nacks / this.stat.orders) * 100).toFixed(2) : '0.00';
    const why = [...this.denyBy].map(([k, n]) => k + '×' + n).join(' ') || 'нет';
    return 'команд ' + this.stat.orders + ', відмов ' + this.stat.nacks + ' (' + share + '%), причини ' + why + '; молчание ' + this.stat.silent;
  }

  /** The wire and the harness both deliver verdicts here (SDK 2, 7). */
  feedback(verdictBytes: Uint8Array): void {
    const v = decodeVerdicts(verdictBytes);
    if (v) this.seen(v);
  }

  /** Verdicts of this tick: an accepted command is what keeps the slot (rule 23.2). */
  seen(verdicts: readonly [number, boolean, number][]): void {
    if (verdicts.some(([, ok]) => ok)) this.lastOk = this.t;
    this.stat.nacks += verdicts.filter(([, ok]) => !ok).length;
    /* Один кривой приказ делает мусором весь кадр: вузол отвечает единственным
       вердиктом `[0, false, 1]` на кадр, а не на команду (04-protocol, 6.3).
       Учить по нему нулевую команду — значит обвинить невиновную соту: она
       попадёт в негодные, и голова перестанет туда ходить без причины. */
    const garbage = verdicts.length === 1 && verdicts[0] !== undefined && !verdicts[0][1] && verdicts[0][2] === DENY_GARBAGE;
    if (garbage) {
      this.stat.garbage++;
      this.denyBy.set(DENY_GARBAGE + ':кадр', (this.denyBy.get(DENY_GARBAGE + ':кадр') ?? 0) + 1);
      return;
    }
    /* Отказы по причинам: К3 даёт 2 балла только при нуле отказов и 1 до 0.5 %
       поданных команд (оценивание 8.5). Чтобы не разбирать потом журнал партии,
       причина считается здесь же — голова знает её раньше всех. Мусорный кадр
       считается выше отдельно: он один на весь кадр, а не на команду. */
    for (const [i, ok, code] of verdicts) {
      if (ok) continue;
      /* Причина плюс род команды: «земля» на `move` и «земля» на `needle` — две
         разные ошибки, и по одному коду их не различить. */
      const tag = code + ':' + (this.lastCmd[i]?.kind ?? '?');
      this.denyBy.set(tag, (this.denyBy.get(tag) ?? 0) + 1);
    }
    /* Ground that refuses once refuses every tick: a refused site is remembered
       and the plan dropped, or the Tkach would stand there paying hands for a
       needle that will not rise (12.2, 13.6). */
    for (const [i, ok, code] of verdicts) {
      if (ok) continue;
      const sent = this.lastCmd[i];
      if (!sent) continue;
      /* A refused yard never took the energy and never queued a corpse: the
         count has to come back, or the swarm ceiling would look full forever
         and the yard would spam refusals for the rest of the match. */
      if (sent.yard) this.pending[sent.yard] = Math.max(0, this.pending[sent.yard] - 1);
      if (code === DENY_LAND || code === DENY_OTHER || code === DENY_PATH) {
        if (sent.site) this.badSite.add(sent.site);
        /* `земля` also means "occupied" (04-protocol.md, 6.6): the cell may be
           free again in a few ticks, so the target is set aside rather than
           struck off - but set aside long enough that the head does not spend a
           command on it every tick until the match ends. */
        if (sent.goal) this.badGoal.set(sent.goal, this.t);
        if (sent.unit) this.plans.delete(sent.unit);
      }
    }
  }

  /* --- knowledge ------------------------------------------------------- */

  /** The slot letter names the vertex (rule 5.4); the start needles prove it. */
  private fixSeat(obs: Observe): void {
    const v = this.valley;
    if (this.seatFixed || !v || obs.mine.needles.length === 0) return;
    let best = this.hearth;
    let bestD = Infinity;
    for (const seat of v.seatList()) {
      const d = Math.min(...obs.mine.needles.map((n) => dist(n.q, n.r, seat.q, seat.r)));
      if (d < bestD) {
        bestD = d;
        best = seat;
      }
    }
    this.hearth = best;
    this.seatFixed = true;
  }

  private sync(obs: Observe, v: Valley): void {
    for (const e of obs.own) {
      this.owner.set(key(e.q, e.r), e.owner);
      this.dark.set(key(e.q, e.r), e.dark);
    }
    for (const n of obs.mine.needles) {
      this.owner.set(key(n.q, n.r), this.slot);
      this.dark.set(key(n.q, n.r), n.dark);
    }
    for (const l of obs.mine.losts) this.owner.set(key(l.q, l.r), l.owner);
    for (const ev of obs.events) {
      if (ev.type === 'cap') {
        this.owner.set(key(ev.q, ev.r), ev.p);
        this.capAt.set(key(ev.q, ev.r), obs.t);
      } else if (ev.type === 'raise') {
        this.owner.set(key(ev.q, ev.r), ev.p);
        this.capAt.set(key(ev.q, ev.r), obs.t);
      } else if (ev.type === 'jam') {
        if (ev.own === this.slot) this.jamAt.set(key(ev.q, ev.r), obs.t);
      } else if (ev.type === 'lot') {
        const lot = v.lots()[ev.lot];
        if (lot && ev.p !== null) {
          for (const c of lot.cells) this.owner.set(key(c.q, c.r), ev.p);
        }
      } else if (ev.type === 'build' && ev.p === this.slot) {
        this.pending[ev.cls] = Math.max(0, this.pending[ev.cls] - 1);
      }
    }
    /* A corpse in the yard queue is invisible in the frame (SDK 2), so it is
       counted here; a count that never resolves would freeze the yard. */
    if (obs.t - this.yardAt > 24) {
      this.pending['ткач'] = 0;
      this.pending['клинок'] = 0;
    }

    const live = new Set(obs.mine.units.map((u) => u.id));
    for (const id of [...this.plans.keys()]) if (!live.has(id)) this.plans.delete(id);

    /* Cells a machine stands on this tick. A cell with any body in it - ours or
       a rival's - is refused as `земля` the moment it is named as a target
       (04-protocol.md, 6.6; rule 10.7), and that refusal is not free: it counts
       against K3 and it eats the tick's command without moving anyone. Rivals
       are only the ones in sight; the rest is what the refusal is still for. */
    this.bodies.clear();
    for (const u of obs.mine.units) this.bodies.set(key(u.q, u.r), u.id);
    for (const f of obs.foe) this.bodies.set(key(f.q, f.r), f.id);
  }

  /** Is this cell held by a machine other than `who`? */
  private held(k: string, who?: string): boolean {
    const id = this.bodies.get(k);
    return id !== undefined && id !== who;
  }

  /** Hearth plus needles that burn at full weight: only those carry the thread. */
  private litAnchors(obs: Observe): Hex[] {
    const out: Hex[] = [{ q: this.hearth.q, r: this.hearth.r }];
    for (const n of obs.mine.needles) {
      if (!n.dark && n.weight >= 1) out.push({ q: n.q, r: n.r });
    }
    return out;
  }

  /** Would a needle here burn: does the thread reach it from the network (7.2)? */
  private threaded(at: Hex, o: RulesOracle): boolean {
    return this.anchors.some((a) => o.linkOk(at, a));
  }

  /** How many burning needles hold this cell. One link is a chain a rival cuts by
      taking a single needle; two are a cell that survives the loss (7.2, 7.4). */
  private links(at: Hex, o: RulesOracle): number {
    let n = 0;
    for (const a of this.anchors) if (o.linkOk(at, a)) n++;
    return n;
  }

  private acting(u: MineUnit, v: Valley): boolean {
    if (u.task !== null) return true;
    /* A Tkach on a needle it may heat pays hands with or without a task (13.6). */
    const k = key(u.q, u.r);
    if (u.cls !== 'ткач' || !v.needles.has(k)) return false;
    return this.heatable(k, u.q, u.r, v, this.t);
  }

  /** Rule 9.3 plus the pre-dawn border: may this cell's needle be heated by us? */
  private heatable(k: string, q: number, r: number, v: Valley, t: number): boolean {
    const spec = v.needles.get(k);
    if (!spec || spec.start !== null) return false;
    const own = this.owner.get(k);
    if (own === this.slot) return false;
    const grace = v.num.capGrace;
    const at = this.capAt.get(k);
    if (at !== undefined && t - at < grace) return false;
    if (t < v.dawnAt && v.inCherta({ q, r })) return false;
    return true;
  }

  /* --- plans ----------------------------------------------------------- */

  private unitOrder(u: MineUnit, obs: Observe, v: Valley, o: RulesOracle): Order | null {
    /* Mid-step machines answer `поворот` to everything (10.6), and a frame of
       refusals is a silent tick. Nothing is said to them. */
    if (midStep(u)) return null;

    const plan = this.plans.get(u.id);
    if (plan) {
      const done = this.planDone(plan, obs, v);
      if (done) this.plans.delete(u.id);
      else if (this.stalled(u, plan, obs.t)) {
        /* the same target would lay the same blocked path: set it aside */
        this.plans.delete(u.id);
        this.badGoal.set(plan.key, obs.t);
        this.stat.stall++;
      } else return this.planStep(plan, u);
    }

    const next = this.pickPlan(u, obs, v, o);
    if (!next) return null;
    this.plans.set(u.id, next);
    this.stat[next.kind]++;
    return this.planStep(next, u);
  }

  /** A walk that stopped: short of the target, unmoved for `stall` ticks and the
      plan at least that old. Only walks to a cell count - a Klinok's chase is the
      node's (11.6), and a machine on its target is working, not stuck. */
  private stalled(u: MineUnit, plan: Plan, t: number): boolean {
    if (this.dials.stall <= 0 || plan.kind === 'ram' || plan.kind === 'jam') return false;
    if (same({ q: u.q, r: u.r }, plan.at)) return false;
    const still = this.still.get(u.id);
    return still !== undefined && t - still.since >= this.dials.stall && t - plan.since >= this.dials.stall;
  }

  private planDone(plan: Plan, obs: Observe, v: Valley): boolean {
    const mine = this.owner.get(plan.key) === this.slot;
    if (plan.kind === 'take') return mine || !this.heatable(plan.key, plan.at.q, plan.at.r, v, obs.t);
    /* голка на соте — хоть манифестная, хоть поставленная в бою (26.2) */
    if (plan.kind === 'build') return v.needles.has(plan.key) || this.owner.has(plan.key) || this.badSite.has(plan.key);
    if (plan.kind === 'feed') return !mine || obs.mine.needles.some((n) => key(n.q, n.r) === plan.key && n.dark);
    /* A guard's chase holds while the foe is still in sight on a needle of ours:
       stepped off, it stopped heating it; out of sight, the node drops the chase
       anyway (11.6); and once the needle is theirs there is nothing to save. */
    if (plan.kind === 'ram') return !obs.foe.some((f) => f.id === plan.target && this.owner.get(key(f.q, f.r)) === this.slot);
    /* A jam holds while the needle is still someone else's and still burning:
       a dark or retaken needle yields no loot at all (8.7, 11.4). */
    if (plan.kind === 'jam') {
      const own = this.owner.get(plan.key);
      return own === null || own === this.slot || own === 'K' || this.dark.get(plan.key) === true;
    }
    /* stage: hold the doorstep until dawn opens the ring */
    return obs.t >= v.dawnAt;
  }

  /** One command that moves the plan forward, or none when the plan is walking. */
  private planStep(plan: Plan, u: MineUnit): Order | null {
    const here = same({ q: u.q, r: u.r }, plan.at);
    /* `ram` names the machine and the node walks the Klinok to it (11.6): one
       command, then nothing while the chase is on. */
    if (plan.kind === 'ram') {
      if (plan.target === undefined) return null;
      if (u.task !== null && u.task.ram === plan.target) return null;
      return { kind: 'ram', unit: u.id, target: plan.target };
    }
    /* A jam is thrown from any cell within one of the needle (11.1), so the
       Klinok is not walked onto it - and `jam` with hold is the command the
       world reads, not the step. */
    if (plan.kind === 'jam') {
      if (hexDist({ q: u.q, r: u.r }, plan.at) > 1) {
        if (u.task !== null && u.task.path > 0) return null;
        const step = this.approach(plan.at, u);
        return step ? { kind: 'move', unit: u.id, q: step.q, r: step.r, goal: null, home: true } : null;
      }
      if (u.task !== null && u.task.jam !== null) return null;
      return { kind: 'jam', unit: u.id, target: { q: plan.at.q, r: plan.at.r }, hold: true };
    }
    if (!here) {
      /* Already walking there: the node keeps the path, we keep the channel. */
      if (u.task !== null && u.task.path > 0) return null;
      /* Somebody is standing on the target right now: naming it would come back
         `земля` (10.7). Waiting a tick costs nothing - the body is walking too. */
      if (this.held(plan.key, u.id)) return null;
      return { kind: 'move', unit: u.id, q: plan.at.q, r: plan.at.r, goal: null, home: false };
    }
    if (plan.kind === 'take') return null; // standing on the needle is the heating
    if (plan.kind === 'stage') return null;
    if (plan.kind === 'feed') {
      if (u.task !== null && u.task.feed !== null) return null;
      return { kind: 'feed', unit: u.id, q: plan.at.q, r: plan.at.r };
    }
    if (u.task !== null && u.task.site !== null) return null;
    if (u.cls !== 'ткач') return null;
    /* Майданчик проверялся при выборе плана, а Ткач шёл к нему тактами: за это
       время сота могла стать непригодной (12.2), и команда вернулась бы отказом.
       Проверка повторяется перед подачей, а сота запоминается негодной. */
    const v = this.valley;
    if (v && !this.buildable(plan.key, plan.at, v)) {
      this.badSite.add(plan.key);
      return null;
    }
    return { kind: 'needle', unit: u.id, q: plan.at.q, r: plan.at.r };
  }

  /** A free cell next to the target, nearest to the machine. */
  private approach(at: Hex, u: MineUnit): Hex | null {
    const v = this.valley;
    if (!v) return null;
    let best: Hex | null = null;
    let bestD = Infinity;
    for (const n of ring(at, 1)) {
      const k = key(n.q, n.r);
      if (!v.inValley(n.q, n.r) || !v.at(k).pass || v.needles.has(k)) continue;
      if (this.held(k, u.id)) continue; // занятая сота отобьётся как `земля` (10.7)
      const d = hexDist({ q: u.q, r: u.r }, n);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  private taken(): Set<string> {
    return new Set([...this.plans.values()].map((p) => p.key));
  }

  /** Someone else's plan, or a cell the node refused to walk to lately. */
  private off(k: string, busy: Set<string>): boolean {
    if (busy.has(k)) return true;
    const at = this.badGoal.get(k);
    return at !== undefined && this.t - at < this.dials.forget;
  }

  private pickPlan(u: MineUnit, obs: Observe, v: Valley, o: RulesOracle): Plan | null {
    const busy = this.taken();
    const from: Hex = { q: u.q, r: u.r };
    if (u.cls !== 'ткач') return this.dials.guard ? this.guardPlan(obs, from, busy) : this.jamPlan(obs, v, from, busy);

    const order = this.orderPlan(obs, v, o, from, busy);
    if (order) return order;

    /* A needle of ours that lost the thread is coverage already bought: putting
       it back on the net is the cheapest income in the valley, so it outranks
       walking to a new ruin whenever the energy for one needle is there. */
    const relight = this.relightPlan(obs, v, o, from, busy);
    if (relight) return relight;

    /* The regen of a lit network is 2 energy a tick and the cap is 360: past the
       flood mark energy is the resource going to waste, not the needle price. */
    if (obs.pulse.energy >= this.dials.flood) {
      const rich = this.buildPlan(obs, v, o, from, busy);
      if (rich) return rich;
    }

    const take = this.takePlan(obs, v, o, from, busy);
    if (take) return take;

    const stage = this.stagePlan(obs, v, o, from, busy);
    if (stage) return stage;

    const build = this.buildPlan(obs, v, o, from, busy);
    if (build) return build;

    return this.feedPlan(obs, v, from, busy);
  }

  /** The nearest foe Tkach in sight standing on a needle of ours. Measured before
      writing this: 11-36 sieges a match in plain sight and 10-35 needles lost, most
      after tick 600 - the head saw them and did nothing. The Keeper's Tkachi count
      too: they retake ring needles we hold, and ramming his machines draws no
      answer (21.5). */
  private guardPlan(obs: Observe, from: Hex, busy: Set<string>): Plan | null {
    let best: Plan | null = null;
    let bestD = Infinity;
    for (const f of obs.foe) {
      if (f.cls !== 'ткач') continue;
      const k = key(f.q, f.r);
      if (this.owner.get(k) !== this.slot || busy.has(k)) continue;
      const d = hexDist(from, f);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'ram', at: { q: f.q, r: f.r }, key: k, since: obs.t, target: f.id };
      }
    }
    return best;
  }

  /** A jam takes the needle's coverage for us and leaves its owner nothing (8.7, 11.4).
      The target must be close to our own pull: outside our zone of contact the leash
      turns the Klinok around every 40 ticks and charges a energy for it (10.9). */
  private jamPlan(obs: Observe, v: Valley, from: Hex, busy: Set<string>): Plan | null {
    if (obs.t >= v.dawnAt) return null; // the ring is dead and players' needles are far
    let best: Plan | null = null;
    let bestD = Infinity;
    for (const [k, own] of this.owner) {
      if (own === null || own === this.slot || own === 'K') continue;
      if (this.dark.get(k) === true) continue; // a silent needle has nothing to take
      if (this.off(k, busy)) continue;
      const spec = v.needles.get(k);
      if (!spec || spec.start !== null) continue; // start needles are under the shield (7.6)
      const at = v.cellOf(k);
      /* Near our own needles the Klinok stays inside the zone of contact and the
         needle it darkens is one the owner's thread most likely reaches - the
         only case that yields loot at all. */
      const near = Math.min(...this.anchors.map((a) => hexDist(a, at)));
      if (near > v.num.linkRange) continue;
      const d = hexDist(from, at);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'jam', at, key: k, since: obs.t };
      }
    }
    return best;
  }

  /** The contract pays 30 minutes for three held needles (rule 18) - a needle's whole match. */
  private orderPlan(obs: Observe, v: Valley, o: RulesOracle, from: Hex, busy: Set<string>): Plan | null {
    const board = obs.pub.order;
    if (!board || obs.t > board.to) return null;
    let best: Plan | null = null;
    let bestCost = Infinity;
    for (const c of board.cells) {
      const k = key(c.q, c.r);
      if (this.off(k, busy) || this.owner.get(k) === this.slot) continue;
      if (!this.heatable(k, c.q, c.r, v, obs.t)) continue;
      if (!this.threaded(c, o)) continue;
      const walk = v.travel(o, from, c, 'ткач');
      if (walk === null) continue;
      const heat = this.heatTicks(k, v, obs.t);
      if (obs.t + walk + heat > board.to) continue;
      if (walk < bestCost) {
        bestCost = walk;
        best = { kind: 'take', at: c, key: k, since: obs.t };
      }
    }
    return best;
  }

  /** The whole price table of rule 9.2: a silent needle is taken for 16, not 24. */
  private heatTicks(k: string, v: Valley, t: number): number {
    const own = this.owner.get(k);
    const free = v.num.heatNeedle;
    if (own === null) return free;
    if (own === 'K' && t >= v.dawnAt) return free;
    return this.dark.get(k) === true ? v.num.heatDark : v.num.heatEnemy;
  }

  /** Nearest free needle the thread can hold: ruins always, the ring after dawn. */
  private takePlan(obs: Observe, v: Valley, o: RulesOracle, from: Hex, busy: Set<string>): Plan | null {
    const pool = obs.t >= v.dawnAt ? [...v.ruins, ...v.ringKeys] : v.ruins;
    const near: { k: string; at: Hex; d: number }[] = [];
    for (const k of pool) {
      if (this.off(k, busy)) continue;
      const own = this.owner.get(k);
      if (own !== null && !(own === 'K' && obs.t >= v.dawnAt)) continue;
      const at = v.cellOf(k);
      if (!this.heatable(k, at.q, at.r, v, obs.t)) continue;
      const d = hexDist(from, at);
      if (d > this.dials.reach) continue;
      if (!this.threaded(at, o)) continue;
      near.push({ k, at, d });
    }
    /* The path search is the expensive part, so only the closest few by hex
       distance are asked for a real path. Ring needles pull twice after dawn
       (22.4) and are worth a longer walk. */
    near.sort((a, b) => a.d - b.d);
    let best: Plan | null = null;
    let bestScore = -Infinity;
    for (const c of near.slice(0, 8)) {
      const walk = v.travel(o, from, c.at, 'ткач');
      if (walk === null) continue;
      const pull = v.needles.get(c.k)?.ring || v.needles.get(c.k)?.spoke ? v.num.dawnRing : 1;
      const held = 1 + 0.35 * Math.min(this.links(c.at, o), 4);
      const score = (pull * held) / (walk + this.heatTicks(c.k, v, obs.t));
      if (score > bestScore) {
        bestScore = score;
        best = { kind: 'take', at: c.at, key: c.k, since: obs.t };
      }
    }
    return best;
  }

  /** One Tkach waits out the last ticks next to the ring: standing there is no provocation (21.7). */
  private stagePlan(obs: Observe, v: Valley, o: RulesOracle, from: Hex, busy: Set<string>): Plan | null {
    if (obs.t < v.dawnAt - this.dials.stage || obs.t >= v.dawnAt) return null;
    if ([...this.plans.values()].some((p) => p.kind === 'stage')) return null;
    let best: Plan | null = null;
    let bestWalk = Infinity;
    for (const k of v.ringKeys) {
      const at = v.cellOf(k);
      if (!this.threaded(at, o)) continue;
      for (const n of ring(at, 1)) {
        const nk = key(n.q, n.r);
        if (this.off(nk, busy) || v.needles.has(nk) || !v.inValley(n.q, n.r) || !v.at(nk).pass) continue;
        const walk = v.travel(o, from, n, 'ткач');
        if (walk === null || walk >= bestWalk) continue;
        bestWalk = walk;
        best = { kind: 'stage', at: n, key: nk, since: obs.t };
      }
    }
    return best;
  }

  /** A needle of our own: the bridge that puts unreachable ruins in thread range, or plain growth. */
  private buildPlan(obs: Observe, v: Valley, o: RulesOracle, from: Hex, busy: Set<string>): Plan | null {
    return this.sitePlan(obs, v, o, from, busy, false);
  }

  /** The same site search, but only sites that put a cut needle of ours back on the thread. */
  private relightPlan(obs: Observe, v: Valley, o: RulesOracle, from: Hex, busy: Set<string>): Plan | null {
    if (this.cutNeedles(obs, v).length === 0) return null;
    return this.sitePlan(obs, v, o, from, busy, true);
  }

  private sitePlan(obs: Observe, v: Valley, o: RulesOracle, from: Hex, busy: Set<string>, onlyRelight: boolean): Plan | null {
    const price = v.num.costNeedle;
    if (obs.pulse.energy < price + this.dials.buildSpare + this.reserve) return null;
    if (obs.t >= v.dawnAt) return null;

    const cut = this.cutNeedles(obs, v);
    let best: Plan | null = null;
    let bestScore = 0;
    for (const a of this.anchors) {
      for (const rad of [3, 4, 5]) {
        for (const c of ring(a, rad)) {
          const k = key(c.q, c.r);
          if (this.off(k, busy) || this.badSite.has(k) || !this.buildable(k, c, v)) continue;
          if (!this.threaded(c, o)) continue;
          const back = this.relight(c, cut, o);
          if (onlyRelight && back === 0) continue;
          /* No bonus for redundant links here. The crown (8.6) looks like something
             to build for, but `bot/crown.js` measured the finished network: circuit
             rank 15-47, girth 3, and a simple cycle of six lit needles present on
             every seed. The multiplier is already earned by a network grown for
             coverage, so paying weight for extra links buys nothing - and on one
             seed it shrank the net to 8 lit needles. */
          const score = this.growth(c, v) + back * 40 + this.bridge(c, v, o) * 30;
          if (score <= bestScore) continue;
          const walk = v.travel(o, from, c, 'ткач');
          if (walk === null) continue;
          bestScore = score;
          best = { kind: 'build', at: c, key: k, since: obs.t };
        }
      }
    }
    return bestScore > this.dials.buildGate ? best : null;
  }

  /** Our own needles that went dark from a cut thread, not from a jam (7.4, 11.4). */
  private cutNeedles(obs: Observe, v: Valley): Hex[] {
    const hold = v.num.jamHold;
    const out: Hex[] = [];
    for (const n of obs.mine.needles) {
      if (!n.dark) continue;
      const at = this.jamAt.get(key(n.q, n.r));
      if (at !== undefined && obs.t - at < hold) continue;
      out.push({ q: n.q, r: n.r });
    }
    return out;
  }

  /** Cut needles a needle here would put back on the thread: coverage already paid for. */
  private relight(c: Hex, cut: readonly Hex[], o: RulesOracle): number {
    let n = 0;
    for (const at of cut) {
      if (hexDist(at, c) > 6) continue;
      if (o.linkOk(at, c)) n++;
    }
    return n;
  }

  private buildable(k: string, c: Hex, v: Valley): boolean {
    if (!v.inValley(c.q, c.r)) return false;
    /* Голки, побудовані в бою, до маніфесту не входять (26.2), поэтому карты
       манифеста для «на соте нет голки» (12.2) не хватает: своя же свежая голка
       и чужая, которую мы видели, живут только в памяти. Без этого Ткач ходил
       строить на занятую соту и получал `земля` — все 17 отказов пакета. */
    if (v.needles.has(k) || this.owner.has(k)) return false;
    const land = v.at(k);
    if (!land.pass || !land.build) return false;
    if (v.finds.get(k) === 'dead') return false;
    if (v.inCherta(c)) return false;
    return v.seatList().every((s) => hexDist(s, c) > 2);
  }

  /** Cells this needle would newly pull: land price of what nothing of ours covers yet. */
  private growth(c: Hex, v: Valley): number {
    let sum = 0;
    for (const rad of [0, 1, 2]) {
      for (const cell of ring(c, rad)) {
        if (!v.inValley(cell.q, cell.r)) continue;
        if (this.anchors.some((a) => hexDist(a, cell) <= 2)) continue;
        sum += v.price(cell.q, cell.r);
      }
    }
    return sum;
  }

  /** How many ruins out of thread range this site would bring into it. */
  private bridge(c: Hex, v: Valley, o: RulesOracle): number {
    let n = 0;
    for (const k of v.ruins) {
      if (this.owner.get(k) !== null) continue;
      const at = v.cellOf(k);
      if (hexDist(at, c) > 6 || this.threaded(at, o)) continue;
      if (o.linkOk(at, c)) n++;
    }
    return n;
  }

  /** Feeding shifts coverage one ring out (8.5): worth most on the outermost needle. */
  private feedPlan(obs: Observe, v: Valley, from: Hex, busy: Set<string>): Plan | null {
    let best: Plan | null = null;
    let bestScore = 0;
    for (const n of obs.mine.needles) {
      const k = key(n.q, n.r);
      if (this.off(k, busy) || n.dark || n.weight < 1 || n.fed) continue;
      const at = { q: n.q, r: n.r };
      let free = 0;
      for (const rad of [2, 3, 4]) {
        for (const cell of ring(at, rad)) {
          if (!v.inValley(cell.q, cell.r)) continue;
          if (this.anchors.some((a) => !same(a, at) && hexDist(a, cell) <= 3)) continue;
          free += v.price(cell.q, cell.r);
        }
      }
      const score = free / (1 + hexDist(from, at));
      if (score > bestScore) {
        bestScore = score;
        best = { kind: 'feed', at, key: k, since: obs.t };
      }
    }
    return best;
  }

  /* --- spending -------------------------------------------------------- */

  private yardOrder(obs: Observe, v: Valley): Order | null {
    const wTkach = v.num.weightTkach;
    const wKlinok = v.num.weightKlinok;
    const cap = v.num.squadWeight;
    const tkachi = obs.mine.units.filter((u) => u.cls === 'ткач').length;
    const klinoks = obs.mine.units.length - tkachi;
    const weight = (tkachi + this.pending['ткач']) * wTkach + (klinoks + this.pending['клинок']) * wKlinok;
    /* Late machines never pay for themselves: a needle taken at tick 1100 earns
       less than the walk to it costs in energy that dawn could not spend. */
    if (obs.t > v.ticks - 200) return null;

    /* Two wishes in order of preference, and the first one that fits the swarm and
       the energy wins. A Klinok is wanted only when the channel can carry it: 64
       bytes to start a jam, 8 a tick to hold it and 32 for its hands (11.1, 13.6),
       out of the same scale the Tkachi take their hands from. The fallback matters:
       a wish that does not fit must not block the other one, or the yard stops
       buying the moment the ceiling is one weight away. */
    const wish: { cls: ClsName; price: number; w: number }[] = [];
    /* A Tkach that is wanted and fits goes before any Klinok, and waits for its
       energy rather than let a Klinok take it: a Klinok bought first at 120 start
       energy left nothing for a Tkach, and on two start needles the regen is 0.5
       a tick - five matches of nine stood at 2 needles on tick 300. */
    const tkachFirst = tkachi + this.pending['ткач'] < this.dials.tkachi && weight + wTkach <= cap;
    if (tkachFirst) {
      wish.push({ cls: 'ткач', price: v.num.costTkach, w: wTkach });
    } else if (klinoks + this.pending['клинок'] < this.dials.klinoks && (this.dials.guard || obs.pulse.chanAt >= this.dials.jamChan)) {
      /* the channel gate is the jam's (64 to start, 8 a tick to hold); a guard
         pays only its hands, and only while a chase is on */
      wish.push({ cls: 'клинок', price: v.num.costKlinok, w: wKlinok });
    }
    for (const want of wish) {
      if (weight + want.w > cap) continue;
      if (obs.pulse.energy - this.reserve < want.price) continue;
      this.pending[want.cls]++;
      this.yardAt = obs.t;
      this.stat.yard++;
      return { kind: 'yard', cls: want.cls };
    }
    return null;
  }

  /** A lot is two ruins with no walk and no heating, at second price (17.5). */
  private bidOrder(obs: Observe, v: Valley, o: RulesOracle): Extract<Order, { kind: 'bid' }> | null {
    const reserveBid = v.num.costNeedle;
    this.reserve = 0;
    for (const [i, lot] of v.lots().entries()) {
      if (this.bidden.has(i) || obs.t >= lot.at) continue;
      const worth = lot.cells.some((c) => this.owner.get(key(c.q, c.r)) === null && this.threaded(c, o));
      if (!worth) continue;
      /* Ставка — целое число заряда (17.3), а заряд накапливается по 0.25 за
         такт (8.9): дробная сумма отбивается кодом `торги`, и конверт на этот
         лот пропадает вместе с командой. */
      const amount = Math.floor(Math.min(this.dials.bid, obs.pulse.energy));
      if (amount <= reserveBid) {
        /* Not enough energy yet: hold it back so the yard does not spend it. */
        if (lot.at - obs.t <= 3) this.reserve = reserveBid + 1;
        continue;
      }
      if (lot.at - obs.t > 3) {
        this.reserve = amount;
        continue;
      }
      this.reserve = amount;
      this.stat.bid++;
      return { kind: 'bid', lot: i, amount };
    }
    return null;
  }

  /** Hands and eyes are served by distance to the focus (13.6, 14.6): keep it on the work. */
  private watchOrder(obs: Observe, v: Valley, room: number): Order | null {
    if (room <= 0 || obs.t - this.focusAt < 40) return null;
    const work = obs.mine.units.filter((u) => u.task !== null);
    if (work.length === 0) return null;
    const mid: Hex = {
      q: Math.round(work.reduce((s, u) => s + u.q, 0) / work.length),
      r: Math.round(work.reduce((s, u) => s + u.r, 0) / work.length),
    };
    if (!v.inValley(mid.q, mid.r)) return null;
    if (this.focus && hexDist(this.focus, mid) <= 4) return null;
    this.focus = mid;
    this.focusAt = obs.t;
    return { kind: 'watch', q: mid.q, r: mid.r, keep: 0 };
  }

  /** Six silent ticks hand the slot to the charter (23.2). `halt` on an idle machine is free (13.4). */
  private keepAlive(obs: Observe, v: Valley): Order | null {
    if (obs.t - this.lastOk < this.dials.quiet) return null;
    this.stat.quiet++;
    const idle = obs.mine.units.find((u) => u.task === null && !midStep(u));
    if (idle) return { kind: 'halt', unit: idle.id };
    const at = this.focus ?? this.hearth;
    if (obs.pulse.chanAt < v.num.chanOrder) return null;
    return { kind: 'watch', q: at.q, r: at.r, keep: 0 };
  }
}
