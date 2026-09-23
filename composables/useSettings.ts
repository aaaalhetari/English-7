// All user-tunable settings, stored on this device only.
export interface LlmOption {
  id: string; label: string; repo: string
  task: 'text-generation' | 'text2text-generation'
  size: string; note: string
}

export const LLM_OPTIONS: LlmOption[] = [
  { id: 'off', label: 'Off (use Claude / dictionary)', repo: '', task: 'text-generation', size: '0 MB', note: 'No local model. New words need internet once.' },
  { id: 'qwen3-0.6b', label: 'Qwen3 0.6B', repo: 'onnx-community/Qwen3-0.6B-ONNX', task: 'text-generation', size: '~550 MB', note: 'Good balance. Try this one first.' },
  { id: 'lfm25-350m', label: 'LFM2.5 350M', repo: 'onnx-community/LFM2.5-350M-ONNX', task: 'text-generation', size: '~280 MB', note: 'Fastest and smallest. Weaker quality.' },
  { id: 'gemma3-270m', label: 'Gemma 3 270M', repo: 'onnx-community/gemma-3-270m-it-ONNX', task: 'text-generation', size: '~300 MB', note: 'Very small. May invent meanings.' },
  { id: 'qwen3-1.7b', label: 'Qwen3 1.7B', repo: 'onnx-community/Qwen3-1.7B-ONNX', task: 'text-generation', size: '~1.4 GB', note: 'Best quality, heaviest. May fail on weak phones.' },
  { id: 'lamini-flan-248m', label: 'LaMini-Flan-T5 248M', repo: 'Xenova/LaMini-Flan-T5-248M', task: 'text2text-generation', size: '~250 MB', note: 'Seq2seq. Short, dictionary-like answers.' }
]

let cache: any = null

export function useSettings() {
  if (!cache) {
    cache = {
      // voice
      ttsRepeat: useLocalStorage('set_tts_repeat', 1),
      ttsPrefetch: useLocalStorage('set_tts_prefetch', true),
      voiceId: useLocalStorage('vocab_app_voice_id', 'af_heart'),
      // on-device model
      llmModel: useLocalStorage('set_llm_model', 'off'),
      // evidence rules
      exposuresForGood: useLocalStorage('set_exposures_good', 3),   // views w/o a tap = one "I knew it"
      minGapHours: useLocalStorage('set_min_gap_hours', 6),          // views closer than this count once
      // frontier rules
      masteryRequired: useLocalStorage('set_mastery', 0.8),          // share known before a band is passed
      coverageRequired: useLocalStorage('set_coverage', 0.7),        // share of a band that must have been shown
      bandSize: useLocalStorage('set_band_size', 250),
      probeShare: useLocalStorage('set_probe_share', 0.1),           // random words from the whole list
      // AI-ignored words
      cooldownTurns: useLocalStorage('set_cooldown_turns', 3),
      steerAfter: useLocalStorage('set_steer_after', 4),
      // candidates + display
      candidateCount: useLocalStorage('set_candidates', 50),
      markTargetsOnly: useLocalStorage('set_mark_targets', true)
    }
  }
  return { ...cache, LLM_OPTIONS }
}
