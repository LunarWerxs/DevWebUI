import { useVModel } from "@vueuse/core"

// The v-model that Input (and, later, Textarea) shares: a passive copy of modelValue that
// starts from defaultValue when the parent does not bind one.
export function useTextFieldModel(
  props: { modelValue?: string | number, defaultValue?: string | number },
  emits: (e: "update:modelValue", payload: string | number) => void,
) {
  return useVModel(props, "modelValue", emits, {
    passive: true,
    defaultValue: props.defaultValue,
  })
}
