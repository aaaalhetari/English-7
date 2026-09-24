import Dexie, { type Table } from 'dexie'
import { fsrs, createEmptyCard, Rating, State, generatorParameters } from 'ts-fsrs'
import frequencyData from '~/data/frequency.json'

const scheduler = fsrs(generatorParameters({ enable_fuzz: true }))

/*
  HOW A WORD MOVES THROUGH THE SYSTEM
  -----------------------------------
  1. Watching   - the word appeared in a reply. We count spaced views.
  2. The gate   - N spaced views (default 8, >= 24h apart) with no tap.
                  Below the edge -> enters the scheduler at once.
                  Above the edge -> enters, max M per day (default 10),
                  most frequent first; the rest wait in a queue.
  3. A tap      - enters the scheduler immediately as "not known",
                  wherever the word sits, and resets its view streak.
  4. Scheduler  - FSRS owns the word from then on.
*/

export type Category =
  | 'untracked'        // more common than minTrackRank - never tracked
  | 'unseen'           // above the edge, never appeared
  | 'gap'              // below the edge, never appeared
  | 'gap-watching'     // below the edge, appeared, not through the gate yet
  | 'watching'         // above the edge, appeared, not through the gate yet
  | 'queued'           // above the edge, passed the gate, waiting for today's quota
  | 'learning' | 'review' | 'relearning'

export interface VocabWord {
  lemma: string
  forms_seen: string[]
  freq_rank: number
  cefr: string
  inSrs: boolean
  entrySource: '' | 'views' | 'click'
  enteredAt: number
  seen: number
  counted: number
  streak: number
  clicks: number
  lastCountedAt: number
  lastSeenAt: number
  queued: boolean
  sentCount: number
  deliveredCount: number
  skipped: number
  lastSentAt: number
  lastSentAs: string
  cooldownUntil: number
  card: any
  due: number
  state: number          // -1 not in scheduler, else FSRS state
}

export interface DefCard { key: string; lemma: string; context: string; definition: string; examples: string[]; source: 'claude' | 'local' | 'dictionary'; level: string; created: number }
export interface AudioClip { key: string; blob: Blob }
export interface MetaRow { key: string; value: any }
export interface TurnLog { id?: number; at: number; question: string; edge: number; sent: { lemma: string; source: string }[]; used: string[]; skipped: string[] }
export interface DailyRow { date: string; dueMax: number; delivered: number; turns: number; newIntroduced: number; aboveEntries: number; belowEntries: number; clickEntries: number }

class VocabDatabase extends Dexie {
  words!: Table<VocabWord, string>
  cards!: Table<DefCard, string>
  audio!: Table<AudioClip, string>
  meta!: Table<MetaRow, string>
  turns!: Table<TurnLog, number>
  daily!: Table<DailyRow, string>

  constructor() {
    super('vocab_reader_db')
    this.version(1).stores({ words: 'lemma, status, freq_rank' })
    this.version(2).stores({ words: 'lemma, status, freq_rank' })
    this.version(3).stores({ words: 'lemma, status, freq_rank', cards: 'key, lemma', audio: 'key' })
    this.version(4).stores({ words: 'lemma, freq_rank, due, state', cards: 'key, lemma', audio: 'key', meta: 'key' })
    this.version(5).stores({ words: 'lemma, freq_rank, due, state', cards: 'key, lemma', audio: 'key', meta: 'key', turns: '++id, at' })
    this.version(6).stores({ words: 'lemma, freq_rank, due, state', cards: 'key, lemma', audio: 'key', meta: 'key', turns: '++id, at', daily: 'date' })
    // v7: the entry gate - a word is only in the scheduler once it passed it
    this.version(7).stores({
      words: 'lemma, freq_rank, due, state, inSrs',
      cards: 'key, lemma', audio: 'key', meta: 'key', turns: '++id, at', daily: 'date'
    }).upgrade(async tx => {
      await tx.table('words').toCollection().modify((w: any, ref: any) => {
        if (!(frequencyData as any)[w.lemma]) { delete ref.value; return }
        const scheduled = w.card && ((w.state ?? 0) >= 1 || (w.clicks ?? 0) > 0)
        ref.value = {
          lemma: w.lemma, forms_seen: w.forms_seen || [], freq_rank: w.freq_rank, cefr: w.cefr,
          inSrs: !!scheduled, entrySource: scheduled ? ((w.clicks ?? 0) > 0 ? 'click' : 'views') : '',
          enteredAt: scheduled ? Date.now() : 0,
          seen: w.seen ?? w.total_exposures ?? 0, counted: w.counted ?? 0, streak: 0,
          clicks: w.clicks ?? w.total_clicks ?? 0, lastCountedAt: w.lastCountedAt ?? 0, lastSeenAt: w.lastSeenAt ?? 0,
          queued: false, sentCount: w.sentCount ?? 0, deliveredCount: 0, skipped: w.skipped ?? 0,
          lastSentAt: 0, lastSentAs: '', cooldownUntil: 0,
          card: scheduled ? w.card : null, due: scheduled ? w.due : 0, state: scheduled ? w.state : -1
        }
      })
    })
  }
}

const db = new VocabDatabase()
const freq = frequencyData as Record<string, { rank: number; cefr: string }>
export const RANKS = Object.entries(freq).map(([lemma, m]) => ({ lemma, rank: m.rank, cefr: m.cefr })).sort((a, b) => a.rank - b.rank)
const TOTAL_WORDS = RANKS.length
const today = () => new Date().toISOString().slice(0, 10)
const HOUR = 3600_000

function blank(lemma: string, form = lemma): VocabWord | null {
  const m = freq[lemma]
  if (!m) return null
  return {
    lemma, forms_seen: form ? [form] : [], freq_rank: m.rank, cefr: m.cefr,
    inSrs: false, entrySource: '', enteredAt: 0,
    seen: 0, counted: 0, streak: 0, clicks: 0, lastCountedAt: 0, lastSeenAt: 0, queued: false,
    sentCount: 0, deliveredCount: 0, skipped: 0, lastSentAt: 0, lastSentAs: '', cooldownUntil: 0,
    card: null, due: 0, state: -1
  }
}

function rate(w: VocabWord, rating: any) {
  if (!w.card) w.card = createEmptyCard(new Date())
  const r = scheduler.next(w.card, new Date(), rating)
  w.card = r.card; w.due = +r.card.due; w.state = r.card.state
}

function enter(w: VocabWord, source: 'views' | 'click') {
  w.inSrs = true
  w.entrySource = source
  w.enteredAt = Date.now()
  w.queued = false
  w.card = createEmptyCard(new Date())
  rate(w, source === 'click' ? Rating.Again : Rating.Good)
}

export function useVocabDB() {
  const s = useSettings()

  async function getMeta<T>(key: string, fallback: T): Promise<T> { const r = await db.meta.get(key); return r ? r.value : fallback }
  const setMeta = (key: string, value: any) => db.meta.put({ key, value })
  const getTurn = () => getMeta('turn', 0)

  async function getDay(): Promise<DailyRow> {
    return (await db.daily.get(today())) ||
      { date: today(), dueMax: 0, delivered: 0, turns: 0, newIntroduced: 0, aboveEntries: 0, belowEntries: 0, clickEntries: 0 }
  }

  // ---------------- the edge ----------------
  async function computeEdge() {
    const pct = s.edgePercentile.value ?? 0.98
    const minN = s.minReviewForEdge.value ?? 30
    const all = await db.words.toArray()
    const ranks = all.filter(w => w.inSrs && w.state === State.Review).map(w => w.freq_rank).sort((a, b) => a - b)
    const seed = await getMeta('edgeSeed', 0)
    if (ranks.length < minN) return { edge: seed, reviewCount: ranks.length, pct, fromPlacement: true }
    const edge = ranks[Math.min(ranks.length - 1, Math.floor(ranks.length * pct))]
    return { edge, reviewCount: ranks.length, pct, fromPlacement: false }
  }

  // ---------------- categories ----------------
  function categoryOf(w: Partial<VocabWord> & { freq_rank: number }, edge: number, minRank: number): Category {
    if (w.freq_rank < minRank) return 'untracked'
    if (w.inSrs) return (['learning', 'learning', 'review', 'relearning'] as Category[])[w.state as number] || 'learning'
    if (w.queued) return 'queued'
    const below = w.freq_rank <= edge
    if (!w.seen) return below ? 'gap' : 'unseen'
    return below ? 'gap-watching' : 'watching'
  }

  // ---------------- evidence from a reply ----------------
  async function recordExposures(pairs: { lemma: string; form: string }[]) {
    const minRank = s.minTrackRank.value ?? 300
    const gap = (s.minGapHours.value ?? 24) * HOUR
    const need = s.exposuresForEntry.value ?? 8
    const frac = s.reviewFraction.value ?? 0.5
    const { edge } = await computeEdge()
    const now = Date.now()

    const unique = new Map<string, string>()
    for (const p of pairs) {
      const m = freq[p.lemma]
      if (m && m.rank >= minRank && !unique.has(p.lemma)) unique.set(p.lemma, p.form)
    }
    const lemmas = [...unique.keys()]
    if (!lemmas.length) return

    const day = await getDay()
    await db.transaction('rw', db.words, async () => {
      const rows = await db.words.bulkGet(lemmas)
      const save: VocabWord[] = []
      lemmas.forEach((lemma, i) => {
        let w = rows[i] || blank(lemma, unique.get(lemma))
        if (!w) return
        const form = unique.get(lemma)!
        if (form && !w.forms_seen.includes(form)) w.forms_seen.push(form)
        w.seen++; w.lastSeenAt = now; w.skipped = 0

        if (w.inSrs) {
          // already scheduled: a view counts as a review once enough of its interval passed
          const last = w.card?.last_review ? +new Date(w.card.last_review) : w.lastCountedAt
          const interval = Math.max(0, w.due - last)
          if (now - last >= Math.max(HOUR, interval * frac)) {
            w.counted++; w.lastCountedAt = now
            rate(w, Rating.Good)
          }
        } else if (now - w.lastCountedAt >= gap) {
          // watching: spaced views accumulate toward the gate
          w.counted++; w.lastCountedAt = now; w.streak++
          if (w.streak >= need) {
            if (w.freq_rank <= edge) { enter(w, 'views'); day.belowEntries++ }
            else w.queued = true          // above the edge: admitted by the daily quota below
          }
        }
        save.push(w)
      })
      if (save.length) await db.words.bulkPut(save)
    })
    await db.daily.put(day)
    await admitQueued()
  }

  // Above-edge words that passed the gate enter at most N per day, most frequent first.
  async function admitQueued() {
    const cap = s.aboveEdgeEntriesPerDay.value ?? 10
    const day = await getDay()
    const room = cap - day.aboveEntries
    if (room <= 0) return
    const queued = (await db.words.toArray()).filter(w => w.queued && !w.inSrs).sort((a, b) => a.freq_rank - b.freq_rank).slice(0, room)
    if (!queued.length) return
    queued.forEach(w => enter(w, 'views'))
    await db.words.bulkPut(queued)
    day.aboveEntries += queued.length
    await db.daily.put(day)
  }

  // A tap: enters at once as "not known", wherever the word is; view streak resets.
  async function registerClick(lemma: string) {
    let w = await db.words.get(lemma)
    if (!w) { const b = blank(lemma); if (!b) return; w = b; w.seen = 1; w.lastSeenAt = Date.now() }
    w.clicks++; w.streak = 0
    const day = await getDay()
    if (!w.inSrs) { enter(w, 'click'); day.clickEntries++; await db.daily.put(day) }
    else rate(w, Rating.Again)
    await db.words.put(w)
  }

  async function showMoreOften(lemma: string) {
    const w = await db.words.get(lemma)
    if (!w?.inSrs) return
    w.due = Date.now(); w.card = { ...w.card, due: new Date() }
    await db.words.put(w)
  }
  async function knowItWell(lemma: string) {
    let w = await db.words.get(lemma)
    if (!w) { const b = blank(lemma); if (!b) return; w = b; w.seen = 1 }
    if (!w.inSrs) { enter(w, 'views') }
    rate(w, Rating.Easy)
    await db.words.put(w)
  }

  // ---------------- what gets sent to the AI ----------------
  // Strict order: scheduler reviews due -> gaps below the edge -> new words
  // above the edge (only once nothing is due and no gap is left unshown).
  // Words already shown keep being re-offered until they pass the gate.
  async function getCandidates() {
    const limit = s.candidateCount.value ?? 50
    const minRank = s.minTrackRank.value ?? 300
    const gap = (s.minGapHours.value ?? 24) * HOUR
    const newPerDay = s.newTargetsPerDay.value ?? 10
    const turn = await getTurn()
    const { edge } = await computeEdge()
    const day = await getDay()
    const all = await db.words.toArray()
    const known = new Map(all.map(w => [w.lemma, w]))
    const now = Date.now()
    const free = (w?: VocabWord) => !w || w.cooldownUntil <= turn
    const ready = (w: VocabWord) => now - w.lastCountedAt >= gap   // next view would count

    const due = all.filter(w => w.inSrs && w.due <= now && free(w)).sort((a, b) => a.due - b.due)
    const watching = all.filter(w => !w.inSrs && !w.queued && w.seen > 0 && w.sentCount > 0 && ready(w) && free(w))
    const gapWatch = watching.filter(w => w.freq_rank <= edge).sort((a, b) => a.freq_rank - b.freq_rank)
    const newWatch = watching.filter(w => w.freq_rank > edge).sort((a, b) => a.freq_rank - b.freq_rank)
    const gapsUnseen = RANKS.filter(r => r.rank >= minRank && r.rank <= edge && !known.get(r.lemma)?.seen && free(known.get(r.lemma)))
    const newOpen = due.length === 0 && gapsUnseen.length === 0
    const newRoom = Math.max(0, newPerDay - day.newIntroduced)
    const freshNew = newOpen ? RANKS.filter(r => r.rank > edge && r.rank >= minRank && !known.get(r.lemma)?.seen && free(known.get(r.lemma))).slice(0, newRoom) : []

    const items: { lemma: string; source: string }[] = []
    const taken = new Set<string>()
    const add = (lemma: string, source: string) => { if (!taken.has(lemma) && items.length < limit) { taken.add(lemma); items.push({ lemma, source }) } }
    due.forEach(w => add(w.lemma, 'due'))
    gapWatch.forEach(w => add(w.lemma, 'gap-watching'))
    gapsUnseen.forEach(r => add(r.lemma, 'gap'))
    newWatch.forEach(w => add(w.lemma, 'watching'))
    freshNew.forEach(r => add(r.lemma, 'new'))

    const steerAfter = s.steerAfter.value ?? 15
    const steer = all.filter(w => w.skipped >= steerAfter).sort((a, b) => b.skipped - a.skipped)
      .slice(0, s.maxSteerPerTurn.value ?? 3).map(w => w.lemma)
    steer.forEach(l => add(l, 'steer'))

    return {
      items, words: items.map(i => i.lemma), steer, edge,
      stage: due.length ? 'reviews' : gapsUnseen.length ? 'gaps' : 'new',
      dueCount: due.length, gapUnseen: gapsUnseen.length, gapWatching: gapWatch.length,
      newOpen, newRoom
    }
  }

  async function markSent(items: { lemma: string; source: string }[], dueCount: number) {
    const turn = (await getTurn()) + 1
    await setMeta('turn', turn)
    const now = Date.now()
    await db.transaction('rw', db.words, async () => {
      const rows = await db.words.bulkGet(items.map(i => i.lemma))
      const save: VocabWord[] = []
      items.forEach((it, i) => {
        const w = rows[i] || blank(it.lemma, '')
        if (!w) return
        w.sentCount++; w.lastSentAt = now; w.lastSentAs = it.source
        save.push(w)
      })
      if (save.length) await db.words.bulkPut(save)
    })
    const day = await getDay()
    day.dueMax = Math.max(day.dueMax, dueCount); day.turns++
    await db.daily.put(day)
    return turn
  }

  async function reconcileSent(items: { lemma: string; source: string }[], used: Set<string>, turn: number) {
    const day = await getDay()
    day.delivered += items.filter(i => used.has(i.lemma)).length
    day.newIntroduced += items.filter(i => i.source === 'new' && used.has(i.lemma)).length
    await db.daily.put(day)
    const cooldownAfter = s.cooldownAfter.value ?? 5
    const cooldownTurns = s.cooldownTurns.value ?? 3
    await db.transaction('rw', db.words, async () => {
      const rows = await db.words.bulkGet(items.map(i => i.lemma))
      const save: VocabWord[] = []
      items.forEach((it, i) => {
        const w = rows[i]; if (!w) return
        if (used.has(it.lemma)) w.deliveredCount++
        else { w.skipped++; if (w.skipped >= cooldownAfter) w.cooldownUntil = turn + cooldownTurns }
        save.push(w)
      })
      if (save.length) await db.words.bulkPut(save)
    })
  }

  // ---------------- placement (measure only) ----------------
  function placementStage1() {
    return [800, 2000, 3500, 5500, 8000].map(target => RANKS.find(r => r.rank >= target)!).filter(Boolean).map(r => ({ lemma: r.lemma, rank: r.rank }))
  }
  function placementStage2(unknownStage1: string[], stage1: { lemma: string; rank: number }[]) {
    const firstUnknown = stage1.find(w => unknownStage1.includes(w.lemma))
    const centre = firstUnknown ? firstUnknown.rank : 8000
    const lo = Math.max(s.minTrackRank.value ?? 300, centre - 1800)
    const hi = Math.min(TOTAL_WORDS, centre + 1200)
    const out: { lemma: string; rank: number }[] = []
    for (let i = 0; i < 20; i++) {
      const target = Math.round(lo + (hi - lo) * (i / 19))
      const r = RANKS.find(x => x.rank >= target && !out.some(o => o.lemma === x.lemma) && !stage1.some(o => o.lemma === x.lemma))
      if (r) out.push({ lemma: r.lemma, rank: r.rank })
    }
    return out
  }
  // Nothing enters the scheduler. The result is only a starting edge: the
  // last known word before the first unknown one. An unknown word followed by
  // at least 3 known ones is treated as a stray miss and skipped.
  async function applyPlacement(tested: { lemma: string; rank: number; known: boolean }[]) {
    const sorted = [...tested].sort((a, b) => a.rank - b.rank)
    let edge = sorted.length ? sorted[sorted.length - 1].rank : 0
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].known) continue
      const next = sorted.slice(i + 1, i + 4)
      const stray = next.length === 3 && next.every(w => w.known)
      if (stray) continue
      const prevKnown = [...sorted.slice(0, i)].reverse().find(w => w.known)
      edge = prevKnown ? prevKnown.rank : 0
      break
    }
    await setMeta('edgeSeed', edge)
    await setMeta('placementDone', true)
    return edge
  }
  const isPlacementDone = () => getMeta('placementDone', false)
  const skipPlacement = () => setMeta('placementDone', true)

  // ---------------- reporting ----------------
  async function getStats() {
    const all = await db.words.toArray()
    const now = Date.now()
    const { edge } = await computeEdge()
    const minRank = s.minTrackRank.value ?? 300
    const counts: Record<string, number> = {}
    const map = new Map(all.map(w => [w.lemma, w]))
    for (const r of RANKS) {
      const c = categoryOf(map.get(r.lemma) || { freq_rank: r.rank }, edge, minRank)
      counts[c] = (counts[c] || 0) + 1
    }
    return {
      counts, inSrs: all.filter(w => w.inSrs).length,
      due: all.filter(w => w.inSrs && w.due <= now).length,
      tracked: all.filter(w => w.seen > 0).length, total: TOTAL_WORDS,
      learning: counts.learning || 0, review: counts.review || 0, relearning: counts.relearning || 0
    }
  }

  async function getFullList() {
    const all = await db.words.toArray()
    const map = new Map(all.map(w => [w.lemma, w]))
    const { edge } = await computeEdge()
    const minRank = s.minTrackRank.value ?? 300
    return RANKS.map(r => {
      const w: any = map.get(r.lemma) || { ...blank(r.lemma, '')!, forms_seen: [] }
      return { ...w, category: categoryOf(w, edge, minRank), aboveEdge: w.freq_rank > edge, distance: w.freq_rank - edge }
    })
  }

  const getAllWords = () => db.words.toArray()
  const getIgnoredWords = async () => (await db.words.toArray()).filter(w => w.skipped > 0).sort((a, b) => b.skipped - a.skipped).slice(0, 50)
  const getDaily = (n = 30) => db.daily.orderBy('date').reverse().limit(n).toArray()
  const getToday = () => getDay()

  async function resetWord(lemma: string) {
    const w = await db.words.get(lemma); if (!w) return
    const b = blank(lemma, '')!
    await db.words.put({ ...b, forms_seen: w.forms_seen })
  }

  function cardKey(lemma: string, context: string) { let h = 0; for (let i = 0; i < context.length; i++) h = (h * 31 + context.charCodeAt(i)) | 0; return `${lemma}::${h}` }
  const getCard = (lemma: string, context: string) => db.cards.get(cardKey(lemma, context))
  async function saveCard(c: Omit<DefCard, 'key' | 'created'>) { const f: DefCard = { ...c, key: cardKey(c.lemma, c.context), created: Date.now() }; await db.cards.put(f); return f }
  const countCards = () => db.cards.count()
  const getAudio = async (key: string) => (await db.audio.get(key))?.blob || null
  const saveAudio = (key: string, blob: Blob) => db.audio.put({ key, blob })
  const countAudio = () => db.audio.count()
  async function saveTurn(log: Omit<TurnLog, 'id'>) {
    await db.turns.add(log as TurnLog)
    const n = await db.turns.count()
    if (n > 300) await db.turns.bulkDelete(await db.turns.orderBy('at').limit(n - 300).primaryKeys())
  }
  const getTurns = (n = 50) => db.turns.orderBy('at').reverse().limit(n).toArray()

  async function exportData() {
    const [words, meta, daily] = await Promise.all([db.words.toArray(), db.meta.toArray(), db.daily.toArray()])
    return JSON.stringify({ exported_at: new Date().toISOString(), version: 7, words, meta, daily }, null, 2)
  }
  async function importData(json: string) {
    const p = JSON.parse(json)
    for (const w of p.words || []) {
      const e = await db.words.get(w.lemma)
      if (!e) { await db.words.put(w); continue }
      e.seen = Math.max(e.seen, w.seen ?? 0); e.counted = Math.max(e.counted, w.counted ?? 0); e.clicks = Math.max(e.clicks, w.clicks ?? 0)
      if (w.inSrs && (!e.inSrs || (w.due ?? 0) > e.due)) Object.assign(e, { inSrs: true, card: w.card, due: w.due, state: w.state, entrySource: w.entrySource })
      await db.words.put(e)
    }
    for (const m of p.meta || []) await setMeta(m.key, m.value)
    for (const d of p.daily || []) await db.daily.put(d)
  }

  async function seedDemo() {
    if (await db.words.count()) return
    const rows: VocabWord[] = []
    ;['resilient', 'acknowledge', 'facilitate', 'substantial', 'credible'].forEach((l, i) => {
      const w = blank(l); if (!w) return
      w.seen = 4 + i; w.counted = 3; w.lastSeenAt = Date.now(); w.sentCount = 3
      if (i % 2) { enter(w, 'views') } else { w.streak = 3 }
      rows.push(w)
    })
    await db.words.bulkPut(rows)
  }

  return {
    recordExposures, registerClick, showMoreOften, knowItWell,
    computeEdge, getCandidates, markSent, reconcileSent, categoryOf,
    placementStage1, placementStage2, applyPlacement, isPlacementDone, skipPlacement,
    getStats, getFullList, getAllWords, getIgnoredWords, getDaily, getToday, resetWord,
    getCard, saveCard, countCards, getAudio, saveAudio, countAudio,
    saveTurn, getTurns, exportData, importData, seedDemo, getMeta, setMeta, TOTAL_WORDS
  }
}
