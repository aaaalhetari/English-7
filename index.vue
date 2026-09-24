<script setup lang="ts">
const { apiKey } = useApiKey()
const vocab = useVocabDB()
const demoMode = ref(false)
const placementDone = ref(true)

onMounted(async () => { placementDone.value = await vocab.isPlacementDone() })

function onStartReal(key: string) {
  apiKey.value = key
  demoMode.value = false
}
</script>

<template>
  <ClientOnly>
    <template v-if="apiKey && apiKey.trim()">
      <PlacementTest v-if="!placementDone" @done="placementDone = true" />
      <ReaderPanel v-else />
    </template>
    <DemoPanel v-else-if="demoMode" @start-real="onStartReal" />
    <ApiKeySetup v-else @demo="demoMode = true" />
  </ClientOnly>
</template>
