<script lang="ts">
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/dropdown-menu"
import { defineSlotBox } from "../core/slot-box"

export default defineSlotBox("dropdown-menu-shortcut", cn("ms-auto tracking-widest", skin.shortcut), "span")
</script>
