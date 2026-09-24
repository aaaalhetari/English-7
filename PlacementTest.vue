<script setup lang="ts">
// Adaptive, measure-only placement. Stage 1: five words far apart find the
// rough area. Stage 2: twenty words around that area pin it down. Nothing
// enters the scheduler; the only result is your starting edge.
const emit = defineEmits(['done'])
const vocab = useVocabDB()

const stage = ref<1 | 2 | 3>(1)
const stage1 = ref<{ lemma: string; rank: number }[]>([])
const stage2 = ref<{ lemma: string; rank: number }[]>([])
const unknown = ref<Set<string>>(new Set())
const result = ref(0)

onMounted(() => { stage1.value = vocab.placementStage1() })
const current = computed(() => stage.value === 1 ? stage1.value : stage2.value)

function toggle(lemma: string) {
  const s = new Set(unknown.value)
  s.has(lemma) ? s.delete(lemma) : s.add(lemma)
  unknown.value = s
}

function next() {
  stage2.value = vocab.placementStage2([...unknown.value], stage1.value)
  stage.value = 2
}

async function finish() {
  const tested = [...stage1.value, ...stage2.value].map(w => ({ ...w, known: !unknown.value.has(w.lemma) }))
  result.value = await vocab.applyPlacement(tested)
  stage.value = 3
}

async function skip() { await vocab.skipPlacement(); emit('done') }
</script>

<template>
  <div class="min-h-[100dvh] bg-slate-50">
    <div class="max-w-2xl mx-auto px-4 py-6">
      <template v-if="stage < 3">
        <p class="text-xs text-slate-400 mb-1">Step {{ stage }} of 2</p>
        <h1 class="text-xl font-bold mb-1">{{ stage === 1 ? 'Find your area' : 'Pin it down' }}</h1>
        <p class="text-sm text-slate-500 mb-5">Tap every word you do <strong>not</strong> know. Leave the rest.</p>

        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-6">
          <button v-for="w in current" :key="w.lemma"
            class="border rounded-xl px-3 py-3 text-left transition"
            :class="unknown.has(w.lemma) ? 'bg-rose-50 border-rose-300 text-rose-800' : 'bg-white border-slate-200'"
            @click="toggle(w.lemma)">
            <span class="text-[15px] font-medium">{{ w.lemma }}</span>
            <span class="block text-[10px] text-slate-400">rank {{ w.rank }}</span>
          </button>
        </div>

        <button class="w-full bg-emerald-600 text-white rounded-xl py-3 text-sm font-medium" @click="stage === 1 ? next() : finish()">
          {{ stage === 1 ? 'Next' : 'Finish' }}
        </button>
        <button class="w-full text-slate-400 text-xs py-2" @click="skip">Skip, start from the beginning</button>
        <p class="text-[11px] text-slate-400 mt-3">
          This only measures. No word you see here is added to your learning — words enter later,
          through your reading.
        </p>
      </template>

      <template v-else>
        <h1 class="text-xl font-bold mb-2">Your starting edge: {{ result }}</h1>
        <p class="text-sm text-slate-500 mb-6">
          The AI will write mostly within the {{ Math.max(result, 500) }} most common words. Once
          {{ 30 }} words reach review through your own reading, the edge is calculated from them instead.
        </p>
        <button class="w-full bg-emerald-600 text-white rounded-xl py-3 text-sm font-medium" @click="emit('done')">Start reading</button>
      </template>
    </div>
  </div>
</template>
