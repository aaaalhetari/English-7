<script setup lang="ts">
const emit = defineEmits(['close'])
const vocab = useVocabDB()
const { speak, prefetching, lastError: ttsError } = useTTS()
const { voiceOptions } = useTTS()
const st = useSettings()
const { preload, loading: llmLoading, progress: llmProgress, error: llmError, option: llmOption, lastMs } = useLocalLLM()

const tab = ref<'progress' | 'words' | 'ai' | 'settings'>('progress')
const stats = ref<any>({ tracked: 0, learning: 0, review: 0, relearning: 0, due: 0, clicked: 0, total: 0 })
const edge = ref<any>({ edge: 0, reviewCount: 0, pct: 0.95 })
const daily = ref<any[]>([])
const todayRow = ref<any>({ newIntroduced: 0, aboveEntries: 0, belowEntries: 0, clickEntries: 0 })
const cand = ref<any>({ stage: 'reviews', dueCount: 0, gapUnseen: 0, gapWatching: 0, newOpen: false, newRoom: 0 })
const words = ref<any[]>([])
const ignored = ref<any[]>([])
const cards = ref(0)
const clips = ref(0)
const filter = ref<'due' | 'review' | 'clicked' | 'all'>('due')
const search = ref('')

const STATE_NAME = ['new', 'learning', 'review', 'relearning']
const now = Date.now()

const filtered = computed(() => {
  let list = words.value.filter(w => w.seen > 0)
  if (filter.value === 'due') list = list.filter(w => w.due <= now)
  else if (filter.value === 'review') list = list.filter(w => w.state === 2)
  else if (filter.value === 'clicked') list = list.filter(w => w.clicks > 0)
  const q = search.value.trim().toLowerCase()
  if (q) list = words.value.filter(w => w.lemma.includes(q))
  return list.sort((a, b) => a.due - b.due).slice(0, 300)
})

const hardest = computed(() =>
  words.value.filter(w => w.clicks > 0).sort((a, b) => b.clicks - a.clicks).slice(0, 10))

const maxDue = computed(() => Math.max(1, ...daily.value.map((d: any) => Math.max(d.dueMax, d.delivered))))

async function refresh() {
  const [s, e, all, ig, c, a, d, t, cd] = await Promise.all([
    vocab.getStats(), vocab.computeEdge(), vocab.getAllWords(),
    vocab.getIgnoredWords(), vocab.countCards(), vocab.countAudio(), vocab.getDaily(14),
    vocab.getToday(), vocab.getCandidates()
  ])
  stats.value = s; edge.value = e; words.value = all; ignored.value = ig
  cards.value = c; clips.value = a; daily.value = d; todayRow.value = t; cand.value = cd
}

async function handleExport() {
  const url = URL.createObjectURL(new Blob([await vocab.exportData()], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url; a.download = `vocab_backup_${new Date().toISOString().slice(0, 10)}.json`; a.click()
  URL.revokeObjectURL(url)
}
async function redoPlacement() {
  await vocab.setMeta('placementDone', false)
  location.reload()
}
function triggerImport() {
  const el = document.createElement('input')
  el.type = 'file'; el.accept = 'application/json'
  el.onchange = async (e: any) => { const f = e.target.files[0]; if (f) { await vocab.importData(await f.text()); await refresh() } }
  el.click()
}
function fmtDue(d: number) {
  const diff = d - Date.now()
  if (diff <= 0) return 'now'
  const days = diff / 86400000
  if (days < 1) return Math.round(diff / 3600000) + 'h'
  if (days < 30) return Math.round(days) + 'd'
  return Math.round(days / 30) + 'mo'
}

onMounted(refresh)
</script>

<template>
  <div class="fixed inset-0 bg-slate-50 z-50 flex flex-col">
    <header class="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
      <h2 class="font-bold">Dashboard</h2>
      <button class="text-sm text-slate-500 px-3 py-1.5 rounded-lg hover:bg-slate-100" @click="emit('close')">Done</button>
    </header>

    <nav class="bg-white border-b border-slate-200 flex text-sm">
      <button v-for="t in (['progress','words','ai','settings'] as const)" :key="t"
        class="flex-1 py-2.5 capitalize border-b-2"
        :class="tab === t ? 'border-emerald-600 text-emerald-700 font-medium' : 'border-transparent text-slate-500'"
        @click="tab = t">{{ t }}</button>
    </nav>

    <div class="flex-1 overflow-y-auto">
      <div class="max-w-3xl mx-auto p-4 space-y-4">

        <!-- PROGRESS -->
        <template v-if="tab === 'progress'">
          <div class="bg-white rounded-xl p-4 border border-slate-200">
            <div class="flex items-baseline justify-between mb-2">
              <h3 class="font-medium text-sm">Your edge</h3>
              <span class="text-2xl font-bold text-emerald-600">{{ edge.edge }}<span class="text-sm text-slate-400 font-normal"> / {{ stats.total }}</span></span>
            </div>
            <div class="h-3 bg-slate-100 rounded-full overflow-hidden mb-2">
              <div class="h-full bg-emerald-500 rounded-full" :style="{ width: ((edge.edge / (stats.total || 1)) * 100) + '%' }"></div>
            </div>
            <p class="text-[11px] text-slate-400">
              The rank below which {{ Math.round(edge.pct * 100) }}% of the words you currently hold in review sit.
              It decides how hard the AI writes, and where new words are taken from.
              <template v-if="edge.fromPlacement">Taken from the placement test until {{ st.minReviewForEdge.value }} words reach review ({{ edge.reviewCount }} so far).</template>
              <template v-else>Based on {{ edge.reviewCount }} words in review — it moves up as you master more, and down if you start tapping again.</template>
            </p>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200">
            <h3 class="font-medium text-sm mb-2">What is being sent right now</h3>
            <div class="space-y-2 text-sm">
              <div class="flex items-center gap-2" :class="cand.dueCount ? 'text-slate-900' : 'text-slate-400'">
                <span class="w-5">{{ cand.dueCount ? '▶' : '✓' }}</span>
                <span class="flex-1">1. Reviews due in the scheduler</span><strong>{{ cand.dueCount }}</strong>
              </div>
              <div class="flex items-center gap-2" :class="!cand.dueCount && cand.gapUnseen ? 'text-slate-900' : 'text-slate-400'">
                <span class="w-5">{{ cand.gapUnseen ? (cand.dueCount ? '·' : '▶') : '✓' }}</span>
                <span class="flex-1">2. Gaps below the edge, never shown</span><strong>{{ cand.gapUnseen }}</strong>
              </div>
              <div class="flex items-center gap-2" :class="cand.newOpen ? 'text-slate-900' : 'text-slate-400'">
                <span class="w-5">{{ cand.newOpen ? '▶' : '🔒' }}</span>
                <span class="flex-1">3. New words above the edge</span>
                <strong>{{ cand.newOpen ? `${todayRow.newIntroduced}/${st.newTargetsPerDay.value} today` : 'locked' }}</strong>
              </div>
            </div>
            <p class="text-[11px] text-slate-400 mt-3">
              Step 3 opens only when steps 1 and 2 are empty. Words already shown keep being re-offered
              (once a day) until they pass the gate. Gaps collecting views right now: {{ cand.gapWatching }}.
            </p>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200">
            <h3 class="font-medium text-sm mb-2">Entries into the scheduler today</h3>
            <div class="grid grid-cols-3 gap-2 text-center">
              <div><p class="text-xl font-bold text-emerald-600">{{ todayRow.belowEntries }}</p><p class="text-[11px] text-slate-500">below edge<br>(no limit)</p></div>
              <div><p class="text-xl font-bold text-sky-600">{{ todayRow.aboveEntries }}/{{ st.aboveEdgeEntriesPerDay.value }}</p><p class="text-[11px] text-slate-500">above edge<br>(daily cap)</p></div>
              <div><p class="text-xl font-bold text-rose-500">{{ todayRow.clickEntries }}</p><p class="text-[11px] text-slate-500">by tap<br>(no limit)</p></div>
            </div>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200">
            <h3 class="font-medium text-sm mb-2">All 9,000 words by category</h3>
            <div v-for="(label, key) in {
              review: 'In SRS — review', learning: 'In SRS — learning', relearning: 'In SRS — relearning',
              queued: 'Passed the gate, waiting for quota', 'gap-watching': 'Gaps collecting views',
              watching: 'Above edge collecting views', gap: 'Gaps never shown',
              unseen: 'Above edge never shown', untracked: 'Too common, ignored' }" :key="key"
              class="flex justify-between text-xs py-1 border-b border-slate-50 last:border-0">
              <span class="text-slate-600">{{ label }}</span>
              <span class="font-medium">{{ stats.counts?.[key] || 0 }}</span>
            </div>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200">
            <h3 class="font-medium text-sm mb-1">Backlog: due vs. actually delivered</h3>
            <p class="text-[11px] text-slate-400 mb-3">
              Reviews here only happen when a word appears in a reply, so they can pile up.
              If the amber bars keep growing while the green ones stay flat, the backlog is
              winning and the settings need adjusting.
            </p>
            <div v-if="!daily.length" class="text-sm text-slate-400">No data yet.</div>
            <div v-for="d in daily" :key="d.date" class="mb-2">
              <div class="flex justify-between text-[11px] text-slate-500 mb-0.5">
                <span>{{ d.date.slice(5) }}</span>
                <span>{{ d.delivered }} delivered · {{ d.dueMax }} due · {{ d.turns }} turns</span>
              </div>
              <div class="flex gap-1">
                <div class="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div class="h-full bg-amber-400" :style="{ width: Math.min(100, (d.dueMax / maxDue) * 100) + '%' }"></div>
                </div>
                <div class="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div class="h-full bg-emerald-500" :style="{ width: Math.min(100, (d.delivered / maxDue) * 100) + '%' }"></div>
                </div>
              </div>
            </div>
            <p class="text-[10px] text-slate-400">amber = words waiting · green = words that reached you</p>
          </div>

          <div v-if="hardest.length" class="bg-white rounded-xl p-4 border border-slate-200">
            <h3 class="font-medium text-sm mb-2">Hardest words (most taps)</h3>
            <div class="flex flex-wrap gap-1.5">
              <span v-for="w in hardest" :key="w.lemma" class="text-xs bg-rose-50 border border-rose-200 rounded-full px-2.5 py-1">
                {{ w.lemma }} <span class="text-rose-500">×{{ w.clicks }}</span>
              </span>
            </div>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200 text-xs text-slate-500 space-y-1">
            <p>Saved definition cards: <strong>{{ cards }}</strong> (work offline)</p>
            <p>Cached audio clips: <strong>{{ clips }}</strong><span v-if="prefetching"> · preparing {{ prefetching }} more</span></p>
            <p v-if="ttsError" class="text-amber-600">Voice: {{ ttsError }}</p>
          </div>
        </template>

        <!-- WORDS -->
        <template v-else-if="tab === 'words'">
          <WordTable />
        </template>

        <!-- AI BEHAVIOUR -->
        <template v-else-if="tab === 'ai'">
          <div class="bg-white rounded-xl p-4 border border-slate-200">
            <h3 class="font-medium text-sm mb-1">Words the AI keeps skipping</h3>
            <p class="text-[11px] text-slate-400 mb-3">
              Words we offered that did not make it into a reply. After {{ st.cooldownTurns.value }} offers
              they are rested for a few turns; after {{ st.steerAfter.value }} we ask the AI to steer part of
              its answer toward a subject where they fit.
            </p>
            <div v-if="!ignored.length" class="text-sm text-slate-400">Nothing skipped yet.</div>
            <div v-for="w in ignored" :key="w.lemma" class="flex items-center justify-between py-1.5 border-b border-slate-50 last:border-0">
              <span class="text-sm">{{ w.lemma }}</span>
              <span class="text-[11px] text-slate-400">
                skipped {{ w.skipped }}× · offered {{ w.sentCount }}×
                <span v-if="w.skipped >= st.steerAfter.value" class="text-amber-600">· steering</span>
              </span>
            </div>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200 space-y-3">
            <h3 class="font-medium text-sm">On-device model (offline definitions)</h3>
            <select v-model="st.llmModel.value" class="w-full border border-slate-300 rounded-lg px-2 py-2 text-sm">
              <option v-for="o in st.LLM_OPTIONS" :key="o.id" :value="o.id">{{ o.label }} — {{ o.size }}</option>
            </select>
            <p class="text-xs text-slate-500">{{ llmOption.note }}</p>
            <div class="flex items-center gap-2">
              <button class="text-xs bg-slate-100 rounded-lg px-3 py-1.5" :disabled="st.llmModel.value === 'off'" @click="preload">Download / load now</button>
              <span v-if="llmLoading" class="text-xs text-slate-400">{{ llmProgress }}%</span>
              <span v-else-if="lastMs" class="text-xs text-slate-400">last answer {{ lastMs }} ms</span>
            </div>
            <p v-if="llmError" class="text-xs text-amber-600">{{ llmError }}</p>
            <p class="text-[11px] text-slate-400">
              Downloaded once from Hugging Face, then works offline. Untested on real phones —
              try one, and switch if it is slow or wrong. Claude and the built-in dictionary stay as fallbacks.
            </p>
          </div>
        </template>

        <!-- SETTINGS -->
        <template v-else>
          <div class="bg-white rounded-xl p-4 border border-slate-200 space-y-4">
            <h3 class="font-medium text-sm">Voice</h3>
            <label class="block text-xs text-slate-500">Voice
              <select v-model="st.voiceId.value" class="mt-1 w-full border border-slate-300 rounded-lg px-2 py-2 text-sm">
                <option v-for="v in voiceOptions" :key="v.id" :value="v.id">{{ v.label }}</option>
              </select>
            </label>
            <label class="block text-xs text-slate-500">Say each word {{ st.ttsRepeat.value }}× per tap
              <input v-model.number="st.ttsRepeat.value" type="range" min="1" max="5" class="w-full mt-1" />
            </label>
            <label class="flex items-start gap-2 text-sm">
              <input v-model="st.ttsPrefetch.value" type="checkbox" class="mt-1" />
              <span>Prepare audio in advance
                <span class="block text-[11px] text-slate-400">Generates clips for the words in each reply, so a tap plays with no delay.</span></span>
            </label>
            <button class="text-xs bg-slate-100 rounded-lg px-3 py-1.5" @click="speak('resilient')">Test the voice</button>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200 space-y-4">
            <h3 class="font-medium text-sm">The entry gate (applies to every word)</h3>
            <label class="block text-xs text-slate-500">
              Views without a tap needed to enter: {{ st.exposuresForEntry.value }}
              <input v-model.number="st.exposuresForEntry.value" type="range" min="1" max="15" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">
                The one rule for every word, whatever its rank. Research puts incidental learning at
                roughly 8–10 encounters. A tap always enters the word at once as "not known" and resets this count.
              </span>
            </label>
            <label class="block text-xs text-slate-500">
              Minimum time between two counted views: {{ st.minGapHours.value }} h
              <input v-model.number="st.minGapHours.value" type="range" min="1" max="72" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">
                24h means the fastest possible entry takes {{ st.exposuresForEntry.value }} days. Views closer
                together are recorded but do not count.
              </span>
            </label>
            <label class="block text-xs text-slate-500">
              Words already in the scheduler: a view counts once {{ Math.round(st.reviewFraction.value * 100) }}% of their interval has passed
              <input v-model.number="st.reviewFraction.value" type="range" min="0.1" max="1" step="0.05" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">Stops common words from drifting years away just because they keep appearing.</span>
            </label>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200 space-y-4">
            <h3 class="font-medium text-sm">Your edge</h3>
            <label class="block text-xs text-slate-500">
              Edge percentile: {{ Math.round(st.edgePercentile.value * 100) }}%
              <input v-model.number="st.edgePercentile.value" type="range" min="0.8" max="0.99" step="0.01" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">
                The rank below which this share of your review words sits. Research favours 98% coverage
                for comfortable reading. Higher = easier texts.
              </span>
            </label>
            <label class="block text-xs text-slate-500">
              Use the placement result until {{ st.minReviewForEdge.value }} words are in review
              <input v-model.number="st.minReviewForEdge.value" type="range" min="10" max="200" step="10" class="w-full mt-1" />
            </label>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200 space-y-4">
            <h3 class="font-medium text-sm">Daily limits above the edge</h3>
            <label class="block text-xs text-slate-500">
              New words offered for learning per day: {{ st.newTargetsPerDay.value }}
              <input v-model.number="st.newTargetsPerDay.value" type="range" min="0" max="40" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">
                Counted on words that actually appeared in a reply, not on words merely sent. Only offered
                once nothing is due and no gap is left unshown.
              </span>
            </label>
            <label class="block text-xs text-slate-500">
              Above-edge words allowed into the scheduler per day: {{ st.aboveEdgeEntriesPerDay.value }}
              <input v-model.number="st.aboveEdgeEntriesPerDay.value" type="range" min="0" max="40" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">
                Words above the edge that passed the gate on their own. Extra ones wait in a queue, most
                frequent first. Words below the edge have no limit.
              </span>
            </label>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200 space-y-4">
            <h3 class="font-medium text-sm">What gets sent to the AI</h3>
            <label class="block text-xs text-slate-500">
              Words offered per reply: {{ st.candidateCount.value }}
              <input v-model.number="st.candidateCount.value" type="range" min="10" max="100" step="5" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">Watch the "sent vs delivered" figures: a longer list is not always used.</span>
            </label>
            <label class="block text-xs text-slate-500">
              Previous exchanges sent with each question: {{ st.historyTurns.value }}
              <input v-model.number="st.historyTurns.value" type="range" min="0" max="20" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">
                The AI has no memory: past messages are re-sent every time. Fewer = cheaper, but it forgets
                the start of a long conversation. Your learning data is never affected.
              </span>
            </label>
            <label class="block text-xs text-slate-500">
              Rest a skipped word after {{ st.cooldownAfter.value }} skips, for {{ st.cooldownTurns.value }} turns
              <input v-model.number="st.cooldownAfter.value" type="range" min="1" max="15" class="w-full mt-1" />
              <input v-model.number="st.cooldownTurns.value" type="range" min="1" max="10" class="w-full mt-1" />
            </label>
            <label class="block text-xs text-slate-500">
              Steer the subject after {{ st.steerAfter.value }} skips, max {{ st.maxSteerPerTurn.value }} words per reply
              <input v-model.number="st.steerAfter.value" type="range" min="3" max="40" class="w-full mt-1" />
              <input v-model.number="st.maxSteerPerTurn.value" type="range" min="0" max="10" class="w-full mt-1" />
            </label>
            <label class="block text-xs text-slate-500">
              Ignore words more common than rank {{ st.minTrackRank.value }}
              <input v-model.number="st.minTrackRank.value" type="range" min="0" max="1500" step="50" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">Words like "the" and "not" are never recorded or sent.</span>
            </label>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200 space-y-4">
            <h3 class="font-medium text-sm">Display</h3>
            <label class="flex items-start gap-2 text-sm">
              <input v-model="st.markTargetsOnly.value" type="checkbox" class="mt-1" />
              <span>Highlight only the pushed words
                <span class="block text-[11px] text-slate-400">Every word stays tappable either way — one tap speaks it, two taps open its card.</span></span>
            </label>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200 space-y-2">
            <h3 class="font-medium text-sm">Data</h3>
            <div class="flex gap-2">
              <button class="flex-1 text-xs bg-slate-100 rounded-lg px-3 py-2" @click="handleExport">⬇ Export</button>
              <button class="flex-1 text-xs bg-slate-100 rounded-lg px-3 py-2" @click="triggerImport">⬆ Import</button>
            </div>
            <button class="w-full text-xs bg-slate-100 rounded-lg px-3 py-2" @click="redoPlacement">↻ Redo the placement test</button>
            <p class="text-[11px] text-slate-400">Everything lives in this browser. Import merges: the stronger evidence wins.</p>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
