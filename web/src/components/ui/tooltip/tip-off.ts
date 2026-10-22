import type { Ref } from "vue"
import { computed, watch } from "vue"

// reka's disabled only stops the next open: a tooltip already showing would stay up (as an empty pill
// when the label went). Turning disabled closes it too. Returns the computed "off" the provider takes.
export function useTipOff(props: { readonly disabled: boolean; readonly label: string }, open: Ref<boolean>) {
  const off = computed(() => props.disabled || !props.label)
  watch(off, (v) => {
    if (v) open.value = false
  })
  return off
}
