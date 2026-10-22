<script setup lang="ts">
import DialogRootShell from "../dialog/DialogRootShell.vue"
</script>

<template>
  <DialogRootShell
    v-bind="$attrs"
    data-slot="sheet"
  >
    <template #default="slotProps">
      <slot v-bind="slotProps" />
    </template>
  </DialogRootShell>
</template>
