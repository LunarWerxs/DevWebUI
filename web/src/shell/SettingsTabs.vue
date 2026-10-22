<script setup lang="ts" generic="T extends string">
import { prefersReducedMotion } from '../lib/utils';
// Segmented tab bar for a settings panel: flat buttons in a bordered pill row with the
// active tab lifted onto the page background. Promoted from RepoYeti's Settings
// (2026-07-10) when DevWebUI needed the identical bar; the tab CONTENT stays app-local,
// only the bar is kit. Rule for consumers: keep every tab's sections MOUNTED behind
// v-show (not v-if) whenever a section loads its data from an open-watcher, or a
// section first mounted by a later tab click never runs that watcher.
//
// The active segment is a sliding indicator (absolutely positioned div measured against
// the active button's rect) rather than a per-button background swap, so switching tabs
// animates instead of jump-cutting. Re-measures on tabs/model change and window resize
// (ResizeObserver would be overkill for a handful of flex-basis buttons). The geometry is
// written straight onto the indicator's style, never into reactive state, so a resize
// re-renders nothing; a tab switch slides it by transform alone (see measure()).
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';

const props = defineProps<{ tabs: readonly { id: T; label: string }[] }>();

const model = defineModel<T>({ required: true });

const tablistEl = ref<HTMLElement | null>(null);
const indicatorEl = ref<HTMLElement | null>(null);
const buttonEls = ref<Record<string, HTMLElement | undefined>>({});
// What the indicator shows now; null until the first measure.
let shown: { left: number; width: number } | null = null;

function setButtonEl(id: T, el: Element | ComponentPublicInstance | null) {
  buttonEls.value[id] = (el as HTMLElement) || undefined;
}

/** The --dur-fast motion token in ms; 0 under reduced motion. */
function slideMs(el: HTMLElement): number {
  if (prefersReducedMotion()) return 0;
  const raw = getComputedStyle(el).getPropertyValue('--dur-fast').trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  return raw.endsWith('ms') ? n : n * 1000;
}

/** Puts the indicator under the active tab. With `slide`, a moved indicator gets there by transform
 *  alone (FLIP): its new width applies at once and a scaleX from the old width eases into it, so no
 *  frame re-lays-out the bar. */
function measure(slide = true) {
  const active = buttonEls.value[model.value];
  const list = tablistEl.value;
  const bar = indicatorEl.value;
  if (!active || !list || !bar) return;
  // The indicator is absolutely positioned, so its origin is the tablist's PADDING box, while
  // this measured delta is border-edge to border-edge — hence the clientLeft (= border-left
  // width) subtraction; without it every pill sat right of its own label by the container's pad.
  // Rect-based rather than offsetLeft so a zoomed/transformed ancestor stays consistent.
  const listRect = list.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  const next = { left: rect.left - listRect.left - list.clientLeft, width: rect.width };
  const from = shown;
  shown = next;
  bar.style.setProperty('--indicator-x', `${next.left}px`);
  bar.style.setProperty('--indicator-w', `${next.width}px`);
  const ms = slide && from && next.width > 0 ? slideMs(bar) : 0;
  if (!ms || !from || (from.left === next.left && from.width === next.width)) return;
  bar.animate(
    [
      { transform: `translateX(${from.left}px) scaleX(${from.width / next.width})` },
      { transform: `translateX(${next.left}px) scaleX(1)` },
    ],
    { duration: ms, easing: 'ease-out' },
  );
}

function onResize() {
  measure(false);
}

// One string, so the watch fires when the active tab or the tab list changes, not on every read.
watch(
  () => `${model.value}|${props.tabs.map((tb) => tb.id).join('|')}`,
  () => void nextTick(() => measure()),
  { immediate: true },
);

onMounted(() => {
  void nextTick(() => measure(false));
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <div
    ref="tablistEl"
    role="tablist"
    class="relative flex shrink-0 gap-1 rounded-lg border border-border/60 bg-secondary/30 p-1"
  >
    <div
      ref="indicatorEl"
      class="kit-tab-indicator pointer-events-none absolute inset-y-1 left-0 rounded-md bg-background shadow-sm"
      style="--indicator-x: 0px; --indicator-w: 0px"
      aria-hidden="true"
    />
    <button
      v-for="tb in tabs"
      :key="tb.id"
      :ref="(el) => setButtonEl(tb.id, el)"
      type="button"
      role="tab"
      :aria-selected="model === tb.id"
      class="relative z-10 flex-1 rounded-md px-1 py-1.5 text-ui font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40"
      :class="model === tb.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'"
      @click="model = tb.id"
    >
      {{ tb.label }}
    </button>
  </div>
</template>
