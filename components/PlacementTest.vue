<script setup lang="ts">
// One minute of tapping replaces weeks of guessing: the words are spread across
// the whole 9,000-word list, so the first real starting point comes from you.
const emit = defineEmits(['done'])
const vocab = useVocabDB()
const { speak } = useTTS()

const words = ref<{ lemma: string; rank: number }[]>([])
const unknown = ref<Set<string>>(new Set())
const saving = ref(false)

onMounted(() => { words.value = vocab.placementWords(30) })

function toggle(lemma: string) {
  const s = new Set(unknown.value)
  s.has(lemma) ? s.delete(lemma) : s.add(lemma)
  unknown.value = s
}

async function finish() {
  saving.value = true
  const unknownList = [...unknown.value]
  const knownList = words.value.map(w => w.lemma).filter(l => !unknown.value.has(l))
  await vocab.applyPlacement(knownList, unknownList)
  emit('done')
}

async function skip() {
  await vocab.skipPlacement()
  emit('done')
}
</script>

<template>
  <div class="min-h-[100dvh] bg-slate-50">
    <div class="max-w-2xl mx-auto px-4 py-6">
      <h1 class="text-xl font-bold mb-1">Where should we start?</h1>
      <p class="text-sm text-slate-500 mb-1">
        Tap every word you do <strong>not</strong> know. Leave the rest alone.
      </p>
      <p class="text-xs text-slate-400 mb-5">
        These {{ words.length }} words are spread across the whole list, from common to rare.
        This sets your starting point; the system keeps adjusting it afterwards.
      </p>

      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-6">
        <button
          v-for="w in words" :key="w.lemma"
          class="border rounded-xl px-3 py-3 text-left transition"
          :class="unknown.has(w.lemma)
            ? 'bg-rose-50 border-rose-300 text-rose-800'
            : 'bg-white border-slate-200 hover:border-slate-300'"
          @click="toggle(w.lemma)"
        >
          <span class="text-[15px] font-medium">{{ w.lemma }}</span>
          <span class="block text-[10px] text-slate-400">rank {{ w.rank }}</span>
        </button>
      </div>

      <div class="sticky bottom-4 bg-slate-50 pt-2">
        <p class="text-xs text-slate-500 mb-2">
          {{ unknown.size }} marked as unknown · {{ words.length - unknown.size }} as known
        </p>
        <button class="w-full bg-emerald-600 text-white rounded-xl py-3 text-sm font-medium disabled:opacity-40"
                :disabled="saving" @click="finish">
          {{ saving ? 'Saving…' : 'Start learning' }}
        </button>
        <button class="w-full text-slate-400 text-xs py-2" @click="skip">Skip this, start from the beginning</button>
      </div>
    </div>
  </div>
</template>
