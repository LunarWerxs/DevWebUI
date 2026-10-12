<script setup lang="ts">
// The ⋮ overflow menu of a list row: an icon button that opens a DropdownMenu of actions. A list renders
// one per row, so the menu's reka root (and the content behind it) mounts on first open, not with the row.
// The trigger is a bare button until then; clicking it mounts the menu and opens it in the same gesture.
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOpenedOnce } from "@/composables/useOpenedOnce";

withDefaults(
  defineProps<{
    label: string;
    align?: "start" | "center" | "end";
    contentClass?: string;
  }>(),
  { align: "end" },
);

const open = ref(false);
const { mounted, shown } = useOpenedOnce(open);
</script>

<template>
  <DropdownMenu v-if="mounted" :open="shown" @update:open="open = $event">
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="icon-sm" :aria-label="label">
        <slot name="icon" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent :align="align" :class="contentClass">
      <slot />
    </DropdownMenuContent>
  </DropdownMenu>
  <Button v-else variant="ghost" size="icon-sm" :aria-label="label" @click="open = true">
    <slot name="icon" />
  </Button>
</template>
