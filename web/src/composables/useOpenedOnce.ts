import { ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";

/** Mount an overlay the first time it opens, never before, and keep it mounted after (so its close motion plays). */
export function useOpenedOnce(open: MaybeRefOrGetter<boolean>): {
  mounted: Ref<boolean>;
  shown: Ref<boolean>;
} {
  const mounted = ref(toValue(open));
  const shown = ref(toValue(open));
  const arming = ref(false);
  watch(
    () => toValue(open),
    (value) => {
      if (value && !mounted.value) {
        mounted.value = true;
        arming.value = true;
        return;
      }
      shown.value = value;
    },
    { flush: "sync" },
  );
  // Mount closed, then open within the same flush: the enter motion still plays and one tick later it is open.
  watch(
    arming,
    (value) => {
      if (!value) return;
      arming.value = false;
      shown.value = toValue(open);
    },
    { flush: "post" },
  );
  return { mounted, shown };
}
