<script setup lang="ts">
// The whole 9,000-word curriculum, including words never shown yet, with every
// value the scheduler and the app keep for each one.
const vocab = useVocabDB()
const { speak } = useTTS()

const rows = ref<any[]>([])
const turns = ref<any[]>([])
const loading = ref(true)
const search = ref('')
const stateFilter = ref('any')
const sourceFilter = ref('any')
const sortKey = ref('freq_rank')
const sortDir = ref<'asc' | 'desc'>('asc')
const page = ref(0)
const perPage = 80
const detail = ref<any>(null)

const STATE_NAME: Record<number, string> = { [-1]: 'never shown', 0: 'new', 1: 'learning', 2: 'review', 3: 'relearning' }
const STATE_CLASS: Record<number, string> = {
  [-1]: 'bg-slate-50 text-slate-400', 0: 'bg-slate-100 text-slate-600',
  1: 'bg-sky-100 text-sky-700', 2: 'bg-emerald-100 text-emerald-700', 3: 'bg-rose-100 text-rose-700'
}

const COLUMNS = [
  { key: 'lemma', label: 'word' },
  { key: 'freq_rank', label: 'rank' },
  { key: 'state', label: 'stage' },
  { key: 'seen', label: 'seen' },
  { key: 'counted', label: 'counted' },
  { key: 'clicks', label: 'taps' },
  { key: 'streak', label: 'streak' },
  { key: 'sentCount', label: 'sent' },
  { key: 'skipped', label: 'skipped' },
  { key: 'stability', label: 'stability' },
  { key: 'difficulty', label: 'difficulty' },
  { key: 'reps', label: 'reps' },
  { key: 'lapses', label: 'lapses' },
  { key: 'due', label: 'next' }
]

async function load() {
  loading.value = true
  const [all, t] = await Promise.all([vocab.getFullList(), vocab.getTurns(200)])
  rows.value = all.map((w: any) => ({
    ...w,
    stability: w.card?.stability ? +w.card.stability.toFixed(1) : 0,
    difficulty: w.card?.difficulty ? +w.card.difficulty.toFixed(1) : 0,
    reps: w.card?.reps ?? 0,
    lapses: w.card?.lapses ?? 0
  }))
  turns.value = t
  loading.value = false
}

const appearances = computed(() => {
  const map = new Map<string, { sent: number; used: number; sources: Record<string, number> }>()
  turns.value.forEach(t => t.sent.forEach((it: any) => {
    const e = map.get(it.lemma) || { sent: 0, used: 0, sources: {} }
    e.sent++; e.sources[it.source] = (e.sources[it.source] || 0) + 1
    if (t.used.includes(it.lemma)) e.used++
    map.set(it.lemma, e)
  }))
  return map
})

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  const now = Date.now()
  let list = rows.value.filter(w => {
    if (q && !w.lemma.includes(q)) return false
    if (stateFilter.value === 'unseen' && w.seen > 0) return false
    if (stateFilter.value === 'seen' && w.seen === 0) return false
    if (stateFilter.value === 'due' && !(w.seen > 0 && w.due <= now)) return false
    if (stateFilter.value === 'tapped' && w.clicks === 0) return false
    if (['new', 'learning', 'review', 'relearning'].includes(stateFilter.value)
        && STATE_NAME[w.state] !== stateFilter.value) return false
    if (sourceFilter.value !== 'any') {
      const a = appearances.value.get(w.lemma)
      if (!a || !a.sources[sourceFilter.value]) return false
    }
    return true
  })
  const dir = sortDir.value === 'asc' ? 1 : -1
  const k = sortKey.value
  return [...list].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir)
})

const pageRows = computed(() => filtered.value.slice(0, (page.value + 1) * perPage))

function sortBy(key: string) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortKey.value = key; sortDir.value = 'asc' }
  page.value = 0
}
function fmtDue(w: any) {
  if (!w.seen || !w.due) return '—'
  const diff = w.due - Date.now()
  if (diff <= 0) return 'now'
  const d = diff / 86400000
  return d < 1 ? Math.round(diff / 3600000) + 'h' : d < 30 ? Math.round(d) + 'd' : Math.round(d / 30) + 'mo'
}
function fmtAgo(ts: number) {
  if (!ts) return 'never'
  const d = (Date.now() - ts) / 86400000
  return d < 1 ? Math.round(d * 24) + 'h ago' : Math.round(d) + 'd ago'
}

function exportCsv() {
  const head = ['word','rank','cefr','stage','seen','counted','taps','streak','sent','skipped',
                'stability','difficulty','reps','lapses','due_in','last_seen']
  const lines = [head.join(',')]
  for (const w of filtered.value) {
    lines.push([w.lemma, w.freq_rank, w.cefr, STATE_NAME[w.state], w.seen, w.counted, w.clicks, w.streak,
                w.sentCount, w.skipped, w.stability, w.difficulty, w.reps, w.lapses,
                fmtDue(w), fmtAgo(w.lastSeenAt)].join(','))
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url; a.download = `vocab_words_${filtered.value.length}.csv`; a.click()
  URL.revokeObjectURL(url)
}

async function knowWell(w: any) { await vocab.knowItWell(w.lemma); await load(); detail.value = null }
async function showMore(w: any) { await vocab.showMoreOften(w.lemma); await load(); detail.value = null }
async function reset(w: any) { await vocab.resetWord(w.lemma); await load(); detail.value = null }

onMounted(load)
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap gap-2">
      <input v-model="search" placeholder="Search any of the 9,000 words…"
             class="flex-1 min-w-[150px] border border-slate-300 rounded-lg px-3 py-2 text-sm" />
      <select v-model="stateFilter" class="border border-slate-300 rounded-lg px-2 py-2 text-sm">
        <option value="any">all 9,000</option>
        <option value="seen">met</option>
        <option value="unseen">never shown</option>
        <option value="due">due now</option>
        <option value="tapped">tapped</option>
        <option value="learning">learning</option>
        <option value="review">review</option>
        <option value="relearning">relearning</option>
      </select>
      <select v-model="sourceFilter" class="border border-slate-300 rounded-lg px-2 py-2 text-sm">
        <option value="any">any source</option>
        <option value="due">sent as review</option>
        <option value="new">sent as new</option>
        <option value="steer">sent as steering</option>
      </select>
      <button class="text-xs bg-slate-100 rounded-lg px-3" @click="exportCsv">⬇ CSV</button>
    </div>

    <p class="text-xs text-slate-400">
      {{ filtered.length }} of {{ rows.length }} words · showing {{ pageRows.length }}
      <span v-if="loading">· loading…</span>
    </p>

    <div class="bg-white border border-slate-200 rounded-xl overflow-x-auto">
      <table class="text-sm min-w-full">
        <thead class="bg-slate-50 text-[11px] text-slate-500">
          <tr>
            <th v-for="c in COLUMNS" :key="c.key"
                class="px-2 py-2 text-left font-medium cursor-pointer whitespace-nowrap hover:text-slate-800"
                @click="sortBy(c.key)">
              {{ c.label }}<span v-if="sortKey === c.key">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
            </th>
            <th class="px-2"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-for="w in pageRows" :key="w.lemma" class="hover:bg-slate-50 cursor-pointer" @click="detail = w">
            <td class="px-2 py-2 font-medium whitespace-nowrap">{{ w.lemma }}</td>
            <td class="px-2 text-slate-500">{{ w.freq_rank }}</td>
            <td class="px-2"><span class="text-[11px] rounded-full px-2 py-0.5 whitespace-nowrap" :class="STATE_CLASS[w.state]">{{ STATE_NAME[w.state] }}</span></td>
            <td class="px-2 text-slate-600">{{ w.seen }}</td>
            <td class="px-2 text-slate-500">{{ w.counted }}</td>
            <td class="px-2" :class="w.clicks ? 'text-rose-600 font-medium' : 'text-slate-400'">{{ w.clicks }}</td>
            <td class="px-2 text-slate-500">{{ w.streak }}</td>
            <td class="px-2 text-slate-500">{{ w.sentCount }}</td>
            <td class="px-2" :class="w.skipped ? 'text-amber-600' : 'text-slate-400'">{{ w.skipped }}</td>
            <td class="px-2 text-slate-500">{{ w.stability || '—' }}</td>
            <td class="px-2 text-slate-500">{{ w.difficulty || '—' }}</td>
            <td class="px-2 text-slate-500">{{ w.reps }}</td>
            <td class="px-2" :class="w.lapses ? 'text-rose-500' : 'text-slate-400'">{{ w.lapses }}</td>
            <td class="px-2 whitespace-nowrap" :class="w.seen && w.due <= Date.now() ? 'text-amber-600 font-medium' : 'text-slate-500'">{{ fmtDue(w) }}</td>
            <td class="px-2"><button class="text-slate-300" @click.stop="speak(w.lemma)">🔊</button></td>
          </tr>
          <tr v-if="!pageRows.length && !loading">
            <td colspan="15" class="px-3 py-8 text-center text-sm text-slate-400">No word matches these filters.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <button v-if="pageRows.length < filtered.length"
            class="w-full text-sm bg-white border border-slate-200 rounded-xl py-2 hover:bg-slate-50"
            @click="page++">Show more ({{ filtered.length - pageRows.length }} left)</button>

    <div v-if="detail" class="fixed inset-0 bg-black/30 z-50 flex items-end sm:items-center justify-center" @click.self="detail = null">
      <div class="bg-white rounded-t-2xl sm:rounded-2xl p-5 w-full sm:max-w-md max-h-[85vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-bold text-xl">{{ detail.lemma }}</h3>
          <button class="text-slate-400" @click="speak(detail.lemma)">🔊</button>
        </div>
        <dl class="text-sm divide-y divide-slate-100">
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">rank in the list</dt><dd>{{ detail.freq_rank }} of {{ rows.length }}</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">stage</dt><dd>{{ STATE_NAME[detail.state] }}</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">appeared in replies</dt><dd>{{ detail.seen }}</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">counted as evidence</dt><dd>{{ detail.counted }}</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">you tapped it</dt><dd>{{ detail.clicks }}×</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">counted views since last rating</dt><dd>{{ detail.streak }}</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">offered to the AI</dt><dd>{{ detail.sentCount }}× (skipped {{ detail.skipped }}×)</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">memory stability</dt><dd>{{ detail.stability || '—' }} days</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">difficulty (1–10)</dt><dd>{{ detail.difficulty || '—' }}</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">reviews / lapses</dt><dd>{{ detail.reps }} / {{ detail.lapses }}</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">last seen</dt><dd>{{ fmtAgo(detail.lastSeenAt) }}</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">next review</dt><dd>{{ fmtDue(detail) }}</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">forms seen</dt><dd>{{ detail.forms_seen?.join(', ') || '—' }}</dd></div>
          <div class="flex justify-between py-1.5"><dt class="text-slate-500">offered as</dt>
            <dd><template v-for="(n, src) in (appearances.get(detail.lemma)?.sources || {})" :key="src">{{ src }} ×{{ n }} </template>
              <span v-if="!appearances.get(detail.lemma)">never offered</span></dd>
          </div>
        </dl>
        <div class="grid grid-cols-3 gap-2 mt-4">
          <button class="bg-slate-100 rounded-lg py-2 text-xs" @click="knowWell(detail)">Know it well</button>
          <button class="bg-slate-100 rounded-lg py-2 text-xs" @click="showMore(detail)">Show more often</button>
          <button class="bg-slate-100 rounded-lg py-2 text-xs" @click="reset(detail)">Reset</button>
        </div>
        <button class="mt-2 w-full text-slate-400 text-sm py-1" @click="detail = null">Close</button>
      </div>
    </div>
  </div>
</template>
