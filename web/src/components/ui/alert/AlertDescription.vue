<script lang="ts">
import * as skin from "@ui-skin/alert"
import { cn } from "@ui-skin/cn"
import { defineSlotBox } from "../core/slot-box"

export default defineSlotBox("alert-description", cn("text-balance md:text-pretty [&_p:not(:last-child)]:mb-4 [&_a]:underline [&_a]:underline-offset-3", skin.description))
</script>
