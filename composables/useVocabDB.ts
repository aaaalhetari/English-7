import Dexie, { type Table } from 'dexie'
import { fsrs, createEmptyCard, Rating, State, generatorParameters } from 'ts-fsrs'
import frequencyData from '~/data/frequency.json'

const scheduler = fsrs(generatorParameters({ enable_fuzz: true }))

export interface VocabWord {
  lemma: string
  forms_seen: string[]
  freq_rank: number
  cefr: string
  seen: number            // every appearance in a reply
  counted: number         // appearances that were spaced enough to be evidence
  clicks: number
  streak: number          // counted appearances since the last rating
  lastCountedAt: number
  lastSeenAt: number
  sentCount: number       // times offered to the AI
  skipped: number         // times offered and not used
  cooldownUntil: number
  card: any               // FSRS card
  due: number
  state: number           // 0 new, 1 learning, 2 review, 3 relearning
}

export interface DefCard {
  key: string; lemma: string; context: string
  definition: string; examples: string[]
  source: 'claude' | 'local' | 'dictionary'; level: string; created: number
}
export interface AudioClip { key: string; blob: Blob }
export interface MetaRow { key: string; value: any }
export interface TurnLog {
  id?: number; at: number; question: string; edge: number
  sent: { lemma: string; source: string }[]; used: string[]; skipped: string[]
}
export interface DailyRow { date: string; dueMax: number; delivered: number; turns: number }

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
    // v6: counted views, daily backlog log, and the old status/band fields dropped
    this.version(6).stores({
      words: 'lemma, freq_rank, due, state',
      cards: 'key, lemma', audio: 'key', meta: 'key',
      turns: '++id, at', daily: 'date'
    }).upgrade(async tx => {
      const now = new Date()
      await tx.table('words').toCollection().modify((w: any, ref: any) => {
        const meta = (frequencyData as any)[w.lemma]
        if (!meta) { delete ref.value; return }
        if (w.card) { w.counted = w.counted ?? 0; return }   // already v4/v5 shape
        const seen = w.total_exposures ?? w.seen ?? 0
        const clicks = w.total_clicks ?? w.clicks ?? 0
        let card: any = createEmptyCard(now)
        if (clicks > 0) card = scheduler.next(card, now, Rating.Again).card
        else if (seen >= 3) card = scheduler.next(card, now, Rating.Good).card
        ref.value = {
          lemma: w.lemma, forms_seen: w.forms_seen || [w.lemma],
          freq_rank: meta.rank, cefr: meta.cefr,
          seen, counted: 0, clicks, streak: 0, lastCountedAt: 0, lastSeenAt: Date.now(),
          sentCount: 0, skipped: 0, cooldownUntil: 0,
          card, due: +card.due, state: card.state
        }
      })
    })
  }
}

const db = new VocabDatabase()
const freq = frequencyData as Record<string, { rank: number; cefr: string }>
export const RANKS = Object.entries(freq)
  .map(([lemma, m]) => ({ lemma, rank: m.rank, cefr: m.cefr }))
  .sort((a, b) => a.rank - b.rank)
const TOTAL_WORDS = RANKS.length
const today = () => new Date().toISOString().slice(0, 10)

function blankWord(lemma: string, form: string): VocabWord | null {
  const m = freq[lemma]
  if (!m) return null
  const card = createEmptyCard(new Date())
  return {
    lemma, forms_seen: [form], freq_rank: m.rank, cefr: m.cefr,
    seen: 0, counted: 0, clicks: 0, streak: 0, lastCountedAt: 0, lastSeenAt: 0,
    sentCount: 0, skipped: 0, cooldownUntil: 0,
    card, due: +card.due, state: card.state
  }
}

function rate(w: VocabWord, rating: any, when = new Date()) {
  const res = scheduler.next(w.card, when, rating)
  w.card = res.card
  w.due = +res.card.due
  w.state = res.card.state
  w.streak = 0
}

export function useVocabDB() {
  const s = useSettings()

  // ---------- meta ----------
  async function getMeta<T>(key: string, fallback: T): Promise<T> {
    const row = await db.meta.get(key)
    return row ? row.value : fallback
  }
  const setMeta = (key: string, value: any) => db.meta.put({ key, value })
  const getTurn = () => getMeta('turn', 0)

  // ---------- evidence ----------
  // A view is evidence only if it is spaced out. Before a word reaches review
  // the gap is a fixed number of hours; once it is in review the gap must be a
  // fraction of its own scheduled interval, so words that keep appearing in
  // every text cannot drift years into the future.
  function isEvidence(w: VocabWord, now: number) {
    const gapMs = (s.minGapHours.value ?? 6) * 3600_000
    if (w.state !== State.Review) return now - w.lastCountedAt >= gapMs
    const last = w.card.last_review ? +new Date(w.card.last_review) : w.lastCountedAt
    const interval = w.due - last
    const needed = Math.max(gapMs, interval * (s.reviewFraction.value ?? 0.5))
    return now - last >= needed
  }

  async function recordExposures(pairs: { lemma: string; form: string }[]) {
    const minRank = s.minTrackRank.value ?? 300
    const unique = new Map<string, string>()
    for (const p of pairs) {
      const m = freq[p.lemma]
      if (!m || m.rank < minRank) continue      // very common words are not tracked at all
      if (!unique.has(p.lemma)) unique.set(p.lemma, p.form)
    }
    const lemmas = [...unique.keys()]
    if (!lemmas.length) return
    const now = Date.now()
    const need = s.exposuresForGood.value ?? 3

    await db.transaction('rw', db.words, async () => {
      const existing = await db.words.bulkGet(lemmas)
      const save: VocabWord[] = []
      lemmas.forEach((lemma, i) => {
        const form = unique.get(lemma)!
        let w = existing[i]
        if (!w) { const c = blankWord(lemma, form); if (!c) return; w = c }
        else if (!w.forms_seen.includes(form)) w.forms_seen.push(form)

        w.seen += 1
        w.lastSeenAt = now
        w.skipped = 0
        if (isEvidence(w, now)) {
          w.counted += 1
          w.lastCountedAt = now
          w.streak += 1
          if (w.streak >= need) rate(w, Rating.Good)
        }
        save.push(w)
      })
      if (save.length) await db.words.bulkPut(save)
    })
  }

  async function registerClick(lemma: string) {
    let w = await db.words.get(lemma)
    if (!w) { const c = blankWord(lemma, lemma); if (!c) return; w = c; w.seen = 1; w.lastSeenAt = Date.now() }
    w.clicks += 1
    rate(w, Rating.Again)
    await db.words.put(w)
  }

  // manual controls from the word card
  async function showMoreOften(lemma: string) {
    const w = await db.words.get(lemma)
    if (!w) return
    w.due = Date.now()          // bring it back now, without recording a failure
    w.card = { ...w.card, due: new Date() }
    await db.words.put(w)
  }
  async function knowItWell(lemma: string) {
    let w = await db.words.get(lemma)
    if (!w) { const c = blankWord(lemma, lemma); if (!c) return; w = c; w.seen = 1 }
    rate(w, Rating.Easy)
    await db.words.put(w)
  }

  // ---------- the edge ----------
  // The rank below which <edgePercentile> of the words currently in review sit.
  // Past clicks do not matter: what counts is where the word stands today.
  async function computeEdge() {
    const pct = s.edgePercentile.value ?? 0.95
    const all = await db.words.toArray()
    const reviewRanks = all.filter(w => w.state === State.Review).map(w => w.freq_rank).sort((a, b) => a - b)
    if (!reviewRanks.length) {
      const seed = await getMeta('edgeSeed', 0)
      return { edge: seed, reviewCount: 0, pct }
    }
    const idx = Math.min(reviewRanks.length - 1, Math.floor(reviewRanks.length * pct))
    const edge = reviewRanks[idx]
    await setMeta('edge', edge)
    return { edge, reviewCount: reviewRanks.length, pct }
  }

  // ---------- candidates ----------
  async function getCandidates() {
    const limit = s.candidateCount.value ?? 50
    const newCap = s.newWordCap.value ?? 10
    const steerCap = s.maxSteerPerTurn.value ?? 3
    const steerAfter = s.steerAfter.value ?? 15
    const minRank = s.minTrackRank.value ?? 300
    const turn = await getTurn()
    const { edge } = await computeEdge()
    const all = await db.words.toArray()
    const known = new Map(all.map(w => [w.lemma, w]))
    const now = Date.now()
    const free = (w?: VocabWord) => !w || w.cooldownUntil <= turn

    // 1. words whose review is actually due - never before their time
    const due = all
      .filter(w => w.seen > 0 && w.due <= now && free(w) && w.freq_rank >= minRank)
      .sort((a, b) => a.due - b.due)

    // 2. a small, capped number of new words from just above the edge
    const fresh = RANKS.filter(r => r.rank > edge && r.rank >= minRank &&
      !known.get(r.lemma)?.seen && free(known.get(r.lemma))).slice(0, newCap)

    const items: { lemma: string; source: string }[] = []
    const taken = new Set<string>()
    const add = (lemma: string, source: string) => {
      if (taken.has(lemma) || items.length >= limit) return
      taken.add(lemma); items.push({ lemma, source })
    }
    due.slice(0, limit - fresh.length).forEach(w => add(w.lemma, 'due'))
    fresh.forEach(r => add(r.lemma, 'new'))

    // 3. words the AI has refused many times: ask it to steer the subject
    const steer = all.filter(w => w.skipped >= steerAfter)
      .sort((a, b) => b.skipped - a.skipped).slice(0, steerCap).map(w => w.lemma)
    steer.forEach(l => add(l, 'steer'))

    return { items, words: items.map(i => i.lemma), steer, edge,
             dueCount: due.length, newCount: fresh.length }
  }

  async function markSent(lemmas: string[], dueCount: number) {
    const turn = (await getTurn()) + 1
    await setMeta('turn', turn)
    await db.transaction('rw', db.words, async () => {
      const rows = await db.words.bulkGet(lemmas)
      const save: VocabWord[] = []
      lemmas.forEach((lemma, i) => {
        const w = rows[i] || blankWord(lemma, lemma)
        if (!w) return
        w.sentCount += 1
        save.push(w)
      })
      if (save.length) await db.words.bulkPut(save)
    })
    const d = (await db.daily.get(today())) || { date: today(), dueMax: 0, delivered: 0, turns: 0 }
    d.dueMax = Math.max(d.dueMax, dueCount)
    d.turns += 1
    await db.daily.put(d)
    return turn
  }

  async function reconcileSent(sent: string[], used: Set<string>, turn: number) {
    const cooldownAfter = s.cooldownAfter.value ?? 5
    const cooldownTurns = s.cooldownTurns.value ?? 3
    const ignored = sent.filter(l => !used.has(l))
    const d = (await db.daily.get(today())) || { date: today(), dueMax: 0, delivered: 0, turns: 0 }
    d.delivered += sent.filter(l => used.has(l)).length
    await db.daily.put(d)
    if (!ignored.length) return
    await db.transaction('rw', db.words, async () => {
      const rows = await db.words.bulkGet(ignored)
      const save: VocabWord[] = []
      ignored.forEach((lemma, i) => {
        const w = rows[i]
        if (!w) return
        w.skipped += 1
        if (w.skipped >= cooldownAfter) w.cooldownUntil = turn + cooldownTurns
        save.push(w)
      })
      if (save.length) await db.words.bulkPut(save)
    })
  }

  // ---------- placement test ----------
  // ~30 words spread across the whole list, closer together at the start where
  // most learners sit, so one minute of tapping replaces weeks of guessing.
  function placementWords(count = 30) {
    const minRank = s.minTrackRank.value ?? 300
    const out: { lemma: string; rank: number }[] = []
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1)
      const rank = Math.round(minRank * Math.pow(TOTAL_WORDS / minRank, t))
      const found = RANKS.find(r => r.rank >= rank && !out.some(o => o.lemma === r.lemma))
      if (found) out.push({ lemma: found.lemma, rank: found.rank })
    }
    return out
  }

  async function applyPlacement(known: string[], unknown: string[]) {
    const now = new Date()
    const yesterday = new Date(+now - 86400000)
    const rows: VocabWord[] = []
    for (const lemma of known) {
      const w = blankWord(lemma, lemma); if (!w) continue
      w.seen = 1; w.counted = 1; w.lastSeenAt = +now; w.lastCountedAt = +now
      w.card = scheduler.next(createEmptyCard(yesterday), yesterday, Rating.Good).card
      const second = scheduler.next(w.card, now, Rating.Good)
      w.card = second.card; w.due = +second.card.due; w.state = second.card.state
      rows.push(w)
    }
    for (const lemma of unknown) {
      const w = blankWord(lemma, lemma); if (!w) continue
      w.seen = 1; w.clicks = 1; w.lastSeenAt = +now
      const r = scheduler.next(w.card, now, Rating.Again)
      w.card = r.card; w.due = +r.card.due; w.state = r.card.state
      rows.push(w)
    }
    await db.words.bulkPut(rows)
    // a starting edge, used until enough words reach review on their own
    const knownRanks = known.map(l => freq[l]?.rank || 0).filter(Boolean).sort((a, b) => a - b)
    if (knownRanks.length) {
      const idx = Math.min(knownRanks.length - 1, Math.floor(knownRanks.length * (s.edgePercentile.value ?? 0.95)))
      await setMeta('edgeSeed', knownRanks[idx])
    }
    await setMeta('placementDone', true)
  }
  const isPlacementDone = () => getMeta('placementDone', false)
  const skipPlacement = () => setMeta('placementDone', true)

  // ---------- reporting ----------
  async function getStats() {
    const all = await db.words.toArray()
    const now = Date.now()
    return {
      tracked: all.length,
      learning: all.filter(w => w.state === State.Learning).length,
      review: all.filter(w => w.state === State.Review).length,
      relearning: all.filter(w => w.state === State.Relearning).length,
      due: all.filter(w => w.seen > 0 && w.due <= now).length,
      clicked: all.filter(w => w.clicks > 0).length,
      total: TOTAL_WORDS
    }
  }

  // Full curriculum view: every one of the 9,000 words, with its data if any.
  async function getFullList() {
    const all = await db.words.toArray()
    const known = new Map(all.map(w => [w.lemma, w]))
    return RANKS.map(r => known.get(r.lemma) || {
      lemma: r.lemma, forms_seen: [], freq_rank: r.rank, cefr: r.cefr,
      seen: 0, counted: 0, clicks: 0, streak: 0, lastCountedAt: 0, lastSeenAt: 0,
      sentCount: 0, skipped: 0, cooldownUntil: 0, card: null, due: 0, state: -1
    })
  }

  const getAllWords = () => db.words.toArray()
  const getIgnoredWords = async () =>
    (await db.words.toArray()).filter(w => w.skipped > 0).sort((a, b) => b.skipped - a.skipped).slice(0, 50)
  const getDaily = (n = 30) => db.daily.orderBy('date').reverse().limit(n).toArray()

  async function resetWord(lemma: string) {
    const w = await db.words.get(lemma)
    if (!w) return
    const card = createEmptyCard(new Date())
    Object.assign(w, { seen: 0, counted: 0, clicks: 0, streak: 0, lastCountedAt: 0, lastSeenAt: 0,
      sentCount: 0, skipped: 0, cooldownUntil: 0, card, due: +card.due, state: card.state })
    await db.words.put(w)
  }

  // ---------- cards, audio, turns ----------
  function cardKey(lemma: string, context: string) {
    let h = 0
    for (let i = 0; i < context.length; i++) h = (h * 31 + context.charCodeAt(i)) | 0
    return `${lemma}::${h}`
  }
  const getCard = (lemma: string, context: string) => db.cards.get(cardKey(lemma, context))
  async function saveCard(c: Omit<DefCard, 'key' | 'created'>) {
    const full: DefCard = { ...c, key: cardKey(c.lemma, c.context), created: Date.now() }
    await db.cards.put(full); return full
  }
  const countCards = () => db.cards.count()
  const getAudio = async (key: string) => (await db.audio.get(key))?.blob || null
  const saveAudio = (key: string, blob: Blob) => db.audio.put({ key, blob })
  const countAudio = () => db.audio.count()
  async function saveTurn(log: Omit<TurnLog, 'id'>) {
    await db.turns.add(log as TurnLog)
    const count = await db.turns.count()
    if (count > 300) {
      const oldest = await db.turns.orderBy('at').limit(count - 300).primaryKeys()
      await db.turns.bulkDelete(oldest)
    }
  }
  const getTurns = (n = 50) => db.turns.orderBy('at').reverse().limit(n).toArray()

  // ---------- export / import ----------
  async function exportData() {
    const [words, meta, daily] = await Promise.all([db.words.toArray(), db.meta.toArray(), db.daily.toArray()])
    return JSON.stringify({ exported_at: new Date().toISOString(), version: 6, words, meta, daily }, null, 2)
  }
  async function importData(json: string) {
    const parsed = JSON.parse(json)
    for (const w of parsed.words || []) {
      const existing = await db.words.get(w.lemma)
      if (!existing) { await db.words.put(w); continue }
      existing.seen = Math.max(existing.seen, w.seen ?? 0)
      existing.counted = Math.max(existing.counted ?? 0, w.counted ?? 0)
      existing.clicks = Math.max(existing.clicks, w.clicks ?? 0)
      if ((w.due ?? 0) > (existing.due ?? 0) && w.card) { existing.card = w.card; existing.due = w.due; existing.state = w.state }
      await db.words.put(existing)
    }
    for (const m of parsed.meta || []) await setMeta(m.key, m.value)
    for (const d of parsed.daily || []) await db.daily.put(d)
  }

  async function seedDemo() {
    if (await db.words.count()) return
    const now = new Date(), yest = new Date(Date.now() - 86400000)
    const rows: VocabWord[] = []
    for (const [i, lemma] of ['resilient','acknowledge','facilitate','substantial','credible','marine','momentum'].entries()) {
      const w = blankWord(lemma, lemma); if (!w) continue
      w.seen = 3 + i; w.counted = 2; w.lastSeenAt = Date.now()
      if (i % 3 === 0) { w.clicks = 1; const r = scheduler.next(w.card, now, Rating.Again); w.card = r.card }
      else {
        w.card = scheduler.next(createEmptyCard(yest), yest, Rating.Good).card
        w.card = scheduler.next(w.card, now, Rating.Good).card
      }
      w.due = +w.card.due; w.state = w.card.state
      rows.push(w)
    }
    await db.words.bulkPut(rows)
  }

  return {
    recordExposures, registerClick, showMoreOften, knowItWell,
    computeEdge, getCandidates, markSent, reconcileSent,
    placementWords, applyPlacement, isPlacementDone, skipPlacement,
    getStats, getFullList, getAllWords, getIgnoredWords, getDaily, resetWord,
    getCard, saveCard, countCards, getAudio, saveAudio, countAudio,
    saveTurn, getTurns, exportData, importData, seedDemo, getMeta, setMeta,
    TOTAL_WORDS
  }
}
