<script lang="ts">
import * as skin from "@ui-skin/alert"
import { cn } from "@ui-skin/cn"
import { defineSlotBox } from "../core/slot-box"

export default defineSlotBox("alert-title", cn("font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3", skin.title))
</script>
