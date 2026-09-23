import Dexie, { type Table } from 'dexie'
import { fsrs, createEmptyCard, Rating, State, generatorParameters } from 'ts-fsrs'
import frequencyData from '~/data/frequency.json'

const scheduler = fsrs(generatorParameters({ enable_fuzz: true }))

export interface VocabWord {
  lemma: string
  forms_seen: string[]
  freq_rank: number
  cefr: string
  // evidence
  seen: number              // times the word actually appeared in a reply
  clicks: number            // times the user asked what it means
  streak: number            // counted views since the last rating
  lastCountedAt: number     // timestamp of the last view that counted
  lastSeenAt: number
  // how the AI treats it
  sentCount: number
  skipped: number           // times we offered it and the AI did not use it
  cooldownUntil: number     // turn number until which we stop offering it
  // FSRS
  card: any
  due: number               // ms timestamp, for indexing
  state: number             // 0 new, 1 learning, 2 review, 3 relearning
}

export interface DefCard {
  key: string; lemma: string; context: string
  definition: string; examples: string[]
  source: 'claude' | 'local' | 'dictionary'; level: string; created: number
}
export interface AudioClip { key: string; blob: Blob }
export interface MetaRow { key: string; value: any }

class VocabDatabase extends Dexie {
  words!: Table<VocabWord, string>
  cards!: Table<DefCard, string>
  audio!: Table<AudioClip, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('vocab_reader_db')
    this.version(1).stores({ words: 'lemma, status, freq_rank' })
    this.version(2).stores({ words: 'lemma, status, freq_rank' })
    this.version(3).stores({ words: 'lemma, status, freq_rank', cards: 'key, lemma', audio: 'key' })
    // v4: FSRS scheduling replaces the active/dormant/pool status
    this.version(4).stores({
      words: 'lemma, freq_rank, due, state',
      cards: 'key, lemma',
      audio: 'key',
      meta: 'key'
    }).upgrade(async tx => {
      const freq = frequencyData as Record<string, { rank: number; cefr: string }>
      const now = new Date()
      await tx.table('words').toCollection().modify((w: any, ref: any) => {
        const meta = freq[w.lemma]
        if (!meta) { delete ref.value; return }
        const seen = w.total_exposures ?? 0
        const clicks = w.total_clicks ?? 0
        let card: any = createEmptyCard(now)
        // carry old evidence over: every past click is a lapse, a clean run is a pass
        if (clicks > 0) card = scheduler.next(card, now, Rating.Again).card
        else if (seen >= 3) card = scheduler.next(card, now, Rating.Good).card
        ref.value = {
          lemma: w.lemma, forms_seen: w.forms_seen || [w.lemma],
          freq_rank: meta.rank, cefr: meta.cefr,
          seen, clicks, streak: 0, lastCountedAt: 0, lastSeenAt: Date.now(),
          sentCount: 0, skipped: 0, cooldownUntil: 0,
          card, due: +card.due, state: card.state
        }
      })
    })
  }
}

const db = new VocabDatabase()
const freq = frequencyData as Record<string, { rank: number; cefr: string }>
const RANKS = Object.entries(freq).map(([lemma, m]) => ({ lemma, rank: m.rank, cefr: m.cefr }))
  .sort((a, b) => a.rank - b.rank)
const TOTAL_WORDS = RANKS.length

function newWord(lemma: string, form: string): VocabWord | null {
  const m = freq[lemma]
  if (!m) return null
  const card = createEmptyCard(new Date())
  return {
    lemma, forms_seen: [form], freq_rank: m.rank, cefr: m.cefr,
    seen: 0, clicks: 0, streak: 0, lastCountedAt: 0, lastSeenAt: 0,
    sentCount: 0, skipped: 0, cooldownUntil: 0,
    card, due: +card.due, state: card.state
  }
}

function applyRating(w: VocabWord, rating: any) {
  const res = scheduler.next(w.card, new Date(), rating)
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
  async function setMeta(key: string, value: any) { await db.meta.put({ key, value }) }
  const getTurn = () => getMeta('turn', 0)
  const bumpTurn = async () => { const t = (await getTurn()) + 1; await setMeta('turn', t); return t }

  // ---------- evidence ----------
  // A view only counts if enough time has passed since the last counted view;
  // several counted views in a row without a tap become one "I knew it".
  async function recordExposures(pairs: { lemma: string; form: string }[]) {
    const unique = new Map<string, string>()
    for (const p of pairs) if (!unique.has(p.lemma)) unique.set(p.lemma, p.form)
    const lemmas = [...unique.keys()]
    const now = Date.now()
    const gapMs = (s.minGapHours.value ?? 6) * 3600_000
    const need = s.exposuresForGood.value ?? 3

    await db.transaction('rw', db.words, async () => {
      const existing = await db.words.bulkGet(lemmas)
      const save: VocabWord[] = []
      lemmas.forEach((lemma, i) => {
        const form = unique.get(lemma)!
        let w = existing[i]
        if (!w) {
          const created = newWord(lemma, form)
          if (!created) return
          w = created
        } else if (!w.forms_seen.includes(form)) w.forms_seen.push(form)

        w.seen += 1
        w.lastSeenAt = now
        w.skipped = 0                       // the AI did use it
        if (now - w.lastCountedAt >= gapMs) {
          w.lastCountedAt = now
          w.streak += 1
          if (w.streak >= need) applyRating(w, Rating.Good)
        }
        save.push(w)
      })
      if (save.length) await db.words.bulkPut(save)
    })
  }

  // A tap is strong, immediate evidence that the word is not known yet.
  async function registerClick(lemma: string) {
    let w = await db.words.get(lemma)
    if (!w) {
      const created = newWord(lemma, lemma)
      if (!created) return
      w = created
      w.seen = 1
      w.lastSeenAt = Date.now()
    }
    w.clicks += 1
    applyRating(w, Rating.Again)
    await db.words.put(w)
  }

  // ---------- which words we offered, and what the AI did with them ----------
  async function markSent(lemmas: string[]) {
    const turn = await bumpTurn()
    await db.transaction('rw', db.words, async () => {
      const rows = await db.words.bulkGet(lemmas)
      const save: VocabWord[] = []
      lemmas.forEach((lemma, i) => {
        const w = rows[i] || newWord(lemma, lemma)
        if (!w) return
        w.sentCount += 1
        save.push(w)
      })
      if (save.length) await db.words.bulkPut(save)
    })
    return turn
  }

  // Words we offered but the AI did not use: rest them, then steer the topic.
  async function reconcileSent(sent: string[], used: Set<string>, turn: number) {
    const ignored = sent.filter(l => !used.has(l))
    if (!ignored.length) return
    const cooldown = s.cooldownTurns.value ?? 3
    await db.transaction('rw', db.words, async () => {
      const rows = await db.words.bulkGet(ignored)
      const save: VocabWord[] = []
      ignored.forEach((lemma, i) => {
        const w = rows[i]
        if (!w) return
        w.skipped += 1
        if (w.skipped >= 2) w.cooldownUntil = turn + cooldown
        save.push(w)
      })
      if (save.length) await db.words.bulkPut(save)
    })
  }

  // ---------- frontier ----------
  // Bands of ranks. A band is passed when enough of it has actually been shown
  // (coverage) and enough of what was shown looks known (mastery, estimated
  // with a Beta(1,1) prior so a couple of lucky words cannot pass a band).
  async function computeFrontier() {
    const all = await db.words.toArray()
    const byLemma = new Map(all.map(w => [w.lemma, w]))
    const band = s.bandSize.value ?? 250
    const needMastery = s.masteryRequired.value ?? 0.8
    const needCoverage = s.coverageRequired.value ?? 0.7
    const rows: any[] = []

    for (let start = 0; start < TOTAL_WORDS; start += band) {
      const slice = RANKS.slice(start, start + band)
      let shown = 0, known = 0
      for (const r of slice) {
        const w = byLemma.get(r.lemma)
        if (!w || w.seen === 0) continue
        shown++
        if (w.clicks === 0 && w.state >= State.Review) known++
      }
      const coverage = shown / slice.length
      const mastery = (known + 1) / (shown + 2)     // Beta(1,1) posterior mean
      rows.push({
        from: slice[0].rank, to: slice[slice.length - 1].rank,
        size: slice.length, shown, known, coverage, mastery,
        passed: coverage >= needCoverage && mastery >= needMastery
      })
    }

    let frontier = 0
    for (const r of rows) { if (r.passed) frontier = r.to; else break }
    const stored = await getMeta('frontier', 0)
    const final = Math.max(stored, frontier)      // the frontier never walks back
    if (final !== stored) await setMeta('frontier', final)
    return { frontier: final, rows, total: TOTAL_WORDS }
  }

  const getFrontier = () => getMeta('frontier', 0)

  // ---------- candidate selection ----------
  // Mix, in order of priority: words due for review, words below the frontier
  // that were never shown (the gaps), new words just past the frontier, plus a
  // few random probes from the whole list so the estimate cannot drift.
  async function getCandidates() {
    const limit = s.candidateCount.value ?? 50
    const probeN = Math.max(2, Math.round(limit * (s.probeShare.value ?? 0.1)))
    const turn = await getTurn()
    const frontier = await getFrontier()
    const all = await db.words.toArray()
    const byLemma = new Map(all.map(w => [w.lemma, w]))
    const now = Date.now()
    const available = (w?: VocabWord) => !w || w.cooldownUntil <= turn

    const due = all
      .filter(w => w.seen > 0 && w.due <= now && available(w))
      .sort((a, b) => a.due - b.due)

    const gaps = RANKS.filter(r => r.rank <= frontier && !byLemma.get(r.lemma)?.seen && available(byLemma.get(r.lemma)))
    const fresh = RANKS.filter(r => r.rank > frontier && !byLemma.get(r.lemma)?.seen && available(byLemma.get(r.lemma)))

    const picked: string[] = []
    const add = (lemma: string) => { if (!picked.includes(lemma) && picked.length < limit) picked.push(lemma) }

    // dynamic split: reviews never take more than 60% of the list
    due.slice(0, Math.round(limit * 0.6)).forEach(w => add(w.lemma))
    gaps.slice(0, Math.round(limit * 0.25)).forEach(r => add(r.lemma))
    for (const r of fresh) { if (picked.length >= limit - probeN) break; add(r.lemma) }

    // probes: random ranks across the whole curriculum, easy and hard alike
    for (let i = 0; i < probeN * 4 && picked.length < limit; i++) {
      const r = RANKS[Math.floor(Math.random() * TOTAL_WORDS)]
      if (!byLemma.get(r.lemma)?.seen) add(r.lemma)
    }

    // words the AI keeps refusing: ask it to steer the topic toward them
    const steerAfter = s.steerAfter.value ?? 4
    const steer = all.filter(w => w.skipped >= steerAfter).sort((a, b) => b.skipped - a.skipped).slice(0, 6).map(w => w.lemma)

    return { words: picked, steer, frontier, dueCount: due.length, gapCount: gaps.length }
  }

  // ---------- reporting ----------
  async function getStats() {
    const all = await db.words.toArray()
    const now = Date.now()
    return {
      tracked: all.length,
      learning: all.filter(w => w.state === State.Learning || w.state === State.Relearning).length,
      review: all.filter(w => w.state === State.Review).length,
      due: all.filter(w => w.seen > 0 && w.due <= now).length,
      clicked: all.filter(w => w.clicks > 0).length,
      total: TOTAL_WORDS
    }
  }

  async function getIgnoredWords() {
    const all = await db.words.toArray()
    return all.filter(w => w.skipped > 0).sort((a, b) => b.skipped - a.skipped).slice(0, 50)
  }

  const getAllWords = () => db.words.toArray()

  async function setKnown(lemma: string, known: boolean) {
    const w = await db.words.get(lemma)
    if (!w) return
    applyRating(w, known ? Rating.Easy : Rating.Again)
    if (known) w.clicks = 0
    await db.words.put(w)
  }

  async function resetWord(lemma: string) {
    const w = await db.words.get(lemma)
    if (!w) return
    const card = createEmptyCard(new Date())
    Object.assign(w, { seen: 0, clicks: 0, streak: 0, lastCountedAt: 0, sentCount: 0, skipped: 0, cooldownUntil: 0, card, due: +card.due, state: card.state })
    await db.words.put(w)
  }

  // ---------- definition cards & audio ----------
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

  // ---------- export / import ----------
  async function exportData() {
    const [words, meta] = await Promise.all([db.words.toArray(), db.meta.toArray()])
    return JSON.stringify({ exported_at: new Date().toISOString(), version: 4, words, meta }, null, 2)
  }
  async function importData(json: string) {
    const parsed = JSON.parse(json)
    for (const w of parsed.words || []) {
      const existing = await db.words.get(w.lemma)
      if (!existing) { await db.words.put(w); continue }
      // keep the stronger evidence from either device
      existing.seen = Math.max(existing.seen, w.seen ?? 0)
      existing.clicks = Math.max(existing.clicks, w.clicks ?? 0)
      if ((w.due ?? 0) > (existing.due ?? 0) && w.card) { existing.card = w.card; existing.due = w.due; existing.state = w.state }
      await db.words.put(existing)
    }
    for (const m of parsed.meta || []) {
      if (m.key === 'frontier') await setMeta('frontier', Math.max(await getFrontier(), m.value))
      else await setMeta(m.key, m.value)
    }
  }

  // ---------- demo ----------
  async function seedDemo() {
    if (await db.words.count()) return
    const sample = ['resilient', 'acknowledge', 'facilitate', 'substantial', 'credible', 'marine', 'momentum']
    const now = new Date()
    const rows: VocabWord[] = []
    sample.forEach((lemma, i) => {
      const w = newWord(lemma, lemma)
      if (!w) return
      w.seen = 3 + i
      w.lastSeenAt = Date.now()
      if (i % 3 === 0) { w.clicks = 1; w.card = scheduler.next(w.card, now, Rating.Again).card }
      else { w.card = scheduler.next(w.card, now, Rating.Good).card }
      w.due = +w.card.due; w.state = w.card.state
      rows.push(w)
    })
    await db.words.bulkPut(rows)
  }

  return {
    recordExposures, registerClick, markSent, reconcileSent,
    computeFrontier, getFrontier, getCandidates,
    getStats, getIgnoredWords, getAllWords, setKnown, resetWord,
    getCard, saveCard, countCards, getAudio, saveAudio, countAudio,
    exportData, importData, seedDemo, getMeta, setMeta, TOTAL_WORDS
  }
}
