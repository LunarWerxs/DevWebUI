<script lang="ts">
import { DropdownMenuItem } from "reka-ui"
import * as skin from "@ui-skin/dropdown-menu"
import { defineMenuItem } from "../core/forward-part"

export default defineMenuItem(DropdownMenuItem, "dropdown-menu-item", "group/dropdown-menu-item", skin.item)
</script>
