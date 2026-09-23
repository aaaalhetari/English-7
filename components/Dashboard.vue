<script setup lang="ts">
const emit = defineEmits(['close'])
const vocab = useVocabDB()
const { speak, prefetching, lastError: ttsError } = useTTS()
const { voiceOptions } = useTTS()
const st = useSettings()
const { preload, loading: llmLoading, progress: llmProgress, error: llmError, option: llmOption, lastMs } = useLocalLLM()

const tab = ref<'progress' | 'words' | 'ai' | 'settings'>('progress')
const stats = ref<any>({ tracked: 0, learning: 0, review: 0, due: 0, clicked: 0, total: 0 })
const fr = ref<any>({ frontier: 0, rows: [], total: 0 })
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

const visibleBands = computed(() => {
  const rows = fr.value.rows || []
  const firstUnpassed = rows.findIndex((r: any) => !r.passed)
  const from = Math.max(0, firstUnpassed - 3)
  return rows.slice(from, from + 8)
})

async function refresh() {
  const [s, f, all, ig, c, a] = await Promise.all([
    vocab.getStats(), vocab.computeFrontier(), vocab.getAllWords(),
    vocab.getIgnoredWords(), vocab.countCards(), vocab.countAudio()
  ])
  stats.value = s; fr.value = f; words.value = all; ignored.value = ig; cards.value = c; clips.value = a
}

async function setKnown(lemma: string, known: boolean) { await vocab.setKnown(lemma, known); await refresh() }
async function reset(lemma: string) { await vocab.resetWord(lemma); await refresh() }

async function handleExport() {
  const url = URL.createObjectURL(new Blob([await vocab.exportData()], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url; a.download = `vocab_backup_${new Date().toISOString().slice(0, 10)}.json`; a.click()
  URL.revokeObjectURL(url)
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
              <h3 class="font-medium text-sm">Frontier</h3>
              <span class="text-2xl font-bold text-emerald-600">{{ fr.frontier }}<span class="text-sm text-slate-400 font-normal"> / {{ fr.total }}</span></span>
            </div>
            <div class="h-3 bg-slate-100 rounded-full overflow-hidden mb-2">
              <div class="h-full bg-emerald-500 rounded-full" :style="{ width: ((fr.frontier / (fr.total || 1)) * 100) + '%' }"></div>
            </div>
            <p class="text-[11px] text-slate-400">
              How far you have moved through the 9,000-word list. It only moves forward:
              forgetting an old word is handled by review scheduling, not by moving it back.
            </p>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div class="bg-white rounded-xl p-3 border border-slate-200">
              <p class="text-2xl font-bold">{{ stats.tracked }}</p><p class="text-xs text-slate-500">words met</p></div>
            <div class="bg-white rounded-xl p-3 border border-slate-200">
              <p class="text-2xl font-bold text-emerald-600">{{ stats.review }}</p><p class="text-xs text-slate-500">in review</p></div>
            <div class="bg-white rounded-xl p-3 border border-slate-200">
              <p class="text-2xl font-bold text-amber-500">{{ stats.due }}</p><p class="text-xs text-slate-500">due now</p></div>
            <div class="bg-white rounded-xl p-3 border border-slate-200">
              <p class="text-2xl font-bold text-rose-500">{{ stats.clicked }}</p><p class="text-xs text-slate-500">ever tapped</p></div>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200">
            <h3 class="font-medium text-sm mb-1">Bands around your frontier</h3>
            <p class="text-[11px] text-slate-400 mb-3">
              A band passes when enough of it has actually been shown to you (coverage)
              and enough of what was shown looks known (mastery). Both must pass, so the
              frontier cannot move over words you were never given a chance to see.
            </p>
            <div v-for="b in visibleBands" :key="b.from" class="mb-3">
              <div class="flex justify-between text-xs mb-1">
                <span :class="b.passed ? 'text-emerald-700 font-medium' : 'text-slate-600'">{{ b.from }}–{{ b.to }}</span>
                <span class="text-slate-400">
                  {{ b.shown }}/{{ b.size }} shown ·
                  <template v-if="b.shown">{{ Math.round(b.mastery * 100) }}% known</template>
                  <template v-else>not started</template>
                </span>
              </div>
              <div class="flex gap-1">
                <div class="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden" title="coverage">
                  <div class="h-full bg-sky-400" :style="{ width: Math.round(b.coverage * 100) + '%' }"></div>
                </div>
                <div class="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden" title="mastery">
                  <div class="h-full" :class="b.passed ? 'bg-emerald-500' : 'bg-slate-300'"
                       :style="{ width: (b.shown ? Math.round(b.mastery * 100) : 0) + '%' }"></div>
                </div>
              </div>
            </div>
            <p class="text-[10px] text-slate-400">blue = shown to you · green = looks known</p>
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
            <p>Saved definition cards: <strong>{{ cards }}</strong> (these work offline)</p>
            <p>Cached audio clips: <strong>{{ clips }}</strong><span v-if="prefetching"> · preparing {{ prefetching }} more</span></p>
            <p v-if="ttsError" class="text-amber-600">Voice: {{ ttsError }}</p>
          </div>
        </template>

        <!-- WORDS -->
        <template v-else-if="tab === 'words'">
          <div class="flex gap-2">
            <input v-model="search" placeholder="Search any word…" class="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
            <select v-model="filter" class="border border-slate-300 rounded-lg px-2 text-sm">
              <option value="due">due now</option><option value="review">in review</option>
              <option value="clicked">tapped</option><option value="all">all met</option>
            </select>
          </div>
          <p class="text-xs text-slate-400">{{ filtered.length }} shown</p>
          <div class="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
            <div v-for="w in filtered" :key="w.lemma" class="p-3 flex items-center gap-3">
              <button class="text-slate-400" @click="speak(w.lemma)">🔊</button>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium truncate">{{ w.lemma }}</p>
                <p class="text-[11px] text-slate-400">
                  rank {{ w.freq_rank }} · {{ STATE_NAME[w.state] }} · seen {{ w.seen }} · taps {{ w.clicks }} · next {{ fmtDue(w.due) }}
                </p>
              </div>
              <button class="text-[11px] border border-slate-200 rounded px-2 py-1" @click="setKnown(w.lemma, true)">known</button>
              <button class="text-[11px] text-slate-400 underline" @click="reset(w.lemma)">reset</button>
            </div>
            <p v-if="!filtered.length" class="p-6 text-center text-sm text-slate-400">Nothing here yet.</p>
          </div>
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
                <span class="block text-[11px] text-slate-400">Generates clips for pushed words right after each reply, so a tap plays instantly.</span>
              </span>
            </label>
            <button class="text-xs bg-slate-100 rounded-lg px-3 py-1.5" @click="speak('resilient')">Test the voice</button>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200 space-y-4">
            <h3 class="font-medium text-sm">What counts as evidence</h3>
            <label class="block text-xs text-slate-500">
              Views without a tap that equal one "I knew it": {{ st.exposuresForGood.value }}
              <input v-model.number="st.exposuresForGood.value" type="range" min="1" max="6" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">Lower = faster progress but weaker evidence. A tap always counts immediately as "not known".</span>
            </label>
            <label class="block text-xs text-slate-500">
              Minimum gap between two counted views: {{ st.minGapHours.value }} h
              <input v-model.number="st.minGapHours.value" type="range" min="0" max="48" step="1" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">Seeing a word three times in one long reply is not proof. This spaces the evidence out.</span>
            </label>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200 space-y-4">
            <h3 class="font-medium text-sm">How the frontier moves</h3>
            <label class="block text-xs text-slate-500">
              Mastery needed to pass a band: {{ Math.round(st.masteryRequired.value * 100) }}%
              <input v-model.number="st.masteryRequired.value" type="range" min="0.5" max="0.95" step="0.05" class="w-full mt-1" />
            </label>
            <label class="block text-xs text-slate-500">
              Coverage needed to pass a band: {{ Math.round(st.coverageRequired.value * 100) }}%
              <input v-model.number="st.coverageRequired.value" type="range" min="0.3" max="0.95" step="0.05" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">Guards against your own reading bias: a band cannot pass while most of it has never been shown to you.</span>
            </label>
            <label class="block text-xs text-slate-500">
              Band size: {{ st.bandSize.value }} words
              <input v-model.number="st.bandSize.value" type="range" min="100" max="500" step="50" class="w-full mt-1" />
            </label>
            <label class="block text-xs text-slate-500">
              Random probe words per list: {{ Math.round(st.probeShare.value * 100) }}%
              <input v-model.number="st.probeShare.value" type="range" min="0" max="0.3" step="0.05" class="w-full mt-1" />
              <span class="block text-[11px] text-slate-400">Words drawn from the whole list, far easier and far harder than your position, so the estimate cannot drift.</span>
            </label>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200 space-y-4">
            <h3 class="font-medium text-sm">Conversation</h3>
            <label class="block text-xs text-slate-500">
              Candidate words offered per reply: {{ st.candidateCount.value }}
              <input v-model.number="st.candidateCount.value" type="range" min="10" max="80" step="5" class="w-full mt-1" />
            </label>
            <label class="block text-xs text-slate-500">
              Rest a skipped word for {{ st.cooldownTurns.value }} turns
              <input v-model.number="st.cooldownTurns.value" type="range" min="1" max="10" class="w-full mt-1" />
            </label>
            <label class="block text-xs text-slate-500">
              Steer the topic after {{ st.steerAfter.value }} skips
              <input v-model.number="st.steerAfter.value" type="range" min="2" max="10" class="w-full mt-1" />
            </label>
            <label class="flex items-start gap-2 text-sm">
              <input v-model="st.markTargetsOnly.value" type="checkbox" class="mt-1" />
              <span>Mark pushed words only
                <span class="block text-[11px] text-slate-400">Every word stays tappable either way; this controls how much of the text is highlighted.</span>
              </span>
            </label>
          </div>

          <div class="bg-white rounded-xl p-4 border border-slate-200 space-y-2">
            <h3 class="font-medium text-sm">Data</h3>
            <div class="flex gap-2">
              <button class="flex-1 text-xs bg-slate-100 rounded-lg px-3 py-2" @click="handleExport">⬇ Export</button>
              <button class="flex-1 text-xs bg-slate-100 rounded-lg px-3 py-2" @click="triggerImport">⬆ Import</button>
            </div>
            <p class="text-[11px] text-slate-400">Everything lives in this browser. Import merges: the stronger evidence from either device wins.</p>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
