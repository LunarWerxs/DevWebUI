<script lang="ts">
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/table"
import { defineSlotBox } from "../core/slot-box"

export default defineSlotBox("table-footer", cn("border-t font-medium [&>tr]:last:border-b-0", skin.footer), "tfoot")
</script>
