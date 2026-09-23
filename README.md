# Vocab Reader — Nuxt 3

An interactive reading app: the AI generates natural answers while weaving in
target vocabulary words, and a local tracking system (active / dormant / pool)
prioritizes words that still need review.

Fully static — no backend server. The app calls the Anthropic API directly
from the browser using Anthropic's official "bring your own key" CORS header,
so it deploys as a plain static site (GitHub Pages, Netlify, anywhere).

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. The first screen asks for your **Anthropic API
key** (stored only in `localStorage` on your device, sent directly to
Anthropic per request, never stored on any server).

## Deploy to GitHub Pages (automatic)

1. Push this project to a new GitHub repository.
2. In the repo: **Settings → Pages → Source → GitHub Actions**.
3. Push to `main` (or run the workflow manually from the Actions tab).

`.github/workflows/deploy.yml` is already included — it builds the static
site with `nuxt generate` and publishes it to GitHub Pages automatically on
every push to `main`. Your site will be live at:

```
https://<your-username>.github.io/<repo-name>/
```

No extra setup needed — the workflow sets the correct base path
automatically from your repository name.

## Libraries used and why

| Library | Why |
|---|---|
| **Nuxt 3** (`ssr: false`) | Static-site output, works on GitHub Pages with no server |
| **Pinia + @vueuse/nuxt** | Ready-made composables (`useLocalStorage`, etc.) |
| **Dexie** | IndexedDB wrapper — handles far more data than localStorage, and supports sorting/filtering directly (needed for the "top 50 active words" query) |
| **wink-lemmatizer** | Reduces words to their root locally (no API) — unifies leverage/leveraging, etc. |
| **kokoro-js** (Kokoro-82M) | Neural voice running fully in-browser via Transformers.js/WebGPU (WASM fallback) — free, no API, studio-grade quality (graded A/A- on the model's own benchmark for the voices offered). A small curated picker (5 top-graded English voices, American + British) is built in; switching voices does not re-download the base model. First playback downloads the base model once (~86-138MB in q8); native Web Speech API is the instant fallback if that fails |
| **Tailwind CSS** | Fast, clean styling |

## How reading works

- **One tap** on *any* word says it out loud, instantly (clips for pushed words
  are generated in the background and cached). Repeat count is a setting.
- **Two taps** open the meaning card: contextual definition + examples, written
  for your current position in the word list.
- Only the words the system is currently pushing are highlighted. Everything
  else stays plain but remains tappable, so an unexpected word (a technical
  sense like "terminal" in computing) is one tap away.

## How the learning loop works

1. **Curriculum**: a fixed list of 9,000 words ordered by frequency. The AI
   never reorders it.
2. **Scheduling**: [FSRS](https://github.com/open-spaced-repetition/ts-fsrs)
   (the algorithm behind modern Anki) holds a card per word.
3. **Evidence**: a word appearing in a reply without a tap is weak evidence —
   several spaced views (default 3, minimum 6h apart) add up to one "I knew it".
   A tap is strong, immediate evidence of "not known yet".
4. **Frontier**: your position in the list. It advances band by band, and only
   when a band passes *two* tests: enough of it has actually been shown to you
   (coverage) and enough of what was shown looks known (mastery, estimated with
   a Beta(1,1) posterior so a couple of lucky words cannot pass a band). It
   never moves backwards — forgetting is handled by review scheduling.
5. **Candidates**: each reply is sent with up to 50 words — reviews that are
   due, gaps below the frontier that were never shown, new words just past it,
   plus a few **random probes** from the whole list so the estimate cannot
   drift with your reading habits.
6. **Difficulty**: the frontier is written into the prompt, so the reply itself
   gets harder as you progress.
7. **Skipped words**: words the AI declines to use are rested for a few turns;
   after several skips the prompt asks it to steer part of its answer toward a
   subject where they fit naturally. Words are never forced into the text.

## Dashboard

Four tabs: **Progress** (frontier, counts, band-by-band coverage and mastery,
hardest words, cache sizes), **Words** (search, filter by due/review/tapped,
mark known, reset), **AI** (words the AI keeps skipping, on-device model
picker), **Settings** (voice and repeat, evidence rules, frontier rules,
conversation and display, export/import) — every control has a one-line
explanation underneath it.

## Honest notes on this version's scope

- **`data/frequency.json`** (9,000 words) and **`data/dictionary.json`**
  (an English definition for every one of them) are generated, not
  hand-typed: frequency order comes from
  [wordfreq-en-25000](https://github.com/aparrish/wordfreq-en-25000); each
  word is reduced with the app's own lemmatizer, then kept only if
  [WordNet](https://wordnet.princeton.edu/) lists it as a lowercase common
  word, which removes people, places and most brand names. Profanity,
  internet slang and a short manual list of name-like words are also
  removed. Definitions are WordNet's most frequent sense. CEFR levels are an
  approximation from frequency rank, not a linguist-reviewed
  classification. A1/A2 words are never tracked (already known at B1-B2).
- **Local data upgrades itself**: when the vocabulary list changes, the
  browser database is migrated on first load — untracked/below-level words
  are removed and your click/exposure progress on the rest is kept.
- **Voice runs in a Web Worker** so generating speech never freezes the page.
- **Try before you connect a key**: the setup screen offers "Try a demo
  first" — it seeds sample vocabulary data and a sample AI reply so you can
  test clicking words, the neural voice, and multi-passage selection with
  zero API calls, then lets you paste your key right there to switch into
  the real app.
- **Scanning engine** matches by lemma (root form) only — it doesn't
  disambiguate between two meanings of the same spelling (e.g. "bank" as a
  financial institution vs. a riverbank).
- **Cross-device sync**: manual Export/Import (JSON) buttons only. Drop the
  exported file in a synced Google Drive folder to move data between devices
  — there's no automatic upload/download in this version.
- **API key security**: calling Anthropic directly from the browser means the
  key is visible to anyone with access to the browser's dev tools on that
  device. Fine for a personal, bring-your-own-key tool like this; not
  suitable for a public multi-user product without a server-side key.

## Project structure

```
composables/
  useApiKey.ts       ← stores the key locally
  useVocabDB.ts        ← Dexie database + ranking/status logic
  useLemmatizer.ts     ← tokenizing and lemmatizing text
  useClaude.ts          ← builds prompts, calls Anthropic directly
  useTTS.ts             ← neural + fallback voice
components/
  ApiKeySetup.vue
  DemoPanel.vue          ← try every feature with sample data, no key needed
  ReaderPanel.vue         ← main interface (used once a key is set)
  ClickableText.vue       ← clickable text + multi-selection tool
  WordPopup.vue           ← three-layer meaning popup + voice picker
data/
  frequency.json        ← frequency ranks (starter set, expand it)
  dictionary.json        ← fallback local dictionary (starter set, expand it)
.github/workflows/
  deploy.yml            ← builds and deploys to GitHub Pages on push
```
