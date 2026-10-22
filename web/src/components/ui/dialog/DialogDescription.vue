<script lang="ts">
import { DialogDescription } from "reka-ui"
import * as skin from "@ui-skin/dialog"
import { defineForwardPart } from "../core/forward-part"

export default defineForwardPart(DialogDescription, "dialog-description", skin.description, "*:[a]:underline *:[a]:underline-offset-3")
</script>
