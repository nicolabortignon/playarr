package me.tracklistme.playarr.tv.ui.settings

import android.text.format.DateUtils
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.lazy.LazyListScope
import me.tracklistme.playarr.tv.update.SelfUpdate
import me.tracklistme.playarr.tv.update.UpdateState

/**
 * Settings → About's update row, in the sideload flavor (plan 9 §7). One row whose words follow the state, with a note
 * above it where there's more to say. The row is drawn from one place whatever the state, so it stays the same element
 * and keeps the focus as the state changes (drawn from a branch per state, each change replaced it and the focus fell
 * to the rail, which opened over the page).
 */
fun LazyListScope.updateSettings(updates: SelfUpdate, state: UpdateState) {
  item(key = "update") {
    val row = row(updates, state, System.currentTimeMillis())
    val note = note(state)
    Column {
      if (note != null) Note(note)
      Choice(row.title, row.value, row.detail, row.action)
    }
  }
}

private class Row(val title: String, val value: String = "", val detail: String? = null, val action: () -> Unit = {})

private const val ONCE_A_DAY = "Playarr looks for a new version on GitHub once a day."

/** "2 hours ago", "3 days ago", or the date beyond a week. */
internal fun ago(time: Long, now: Long): String =
  DateUtils.getRelativeTimeSpanString(time, now, DateUtils.MINUTE_IN_MILLIS).toString()

private fun row(updates: SelfUpdate, state: UpdateState, now: Long): Row = when (state) {
  UpdateState.Unknown -> Row("Check for updates", detail = ONCE_A_DAY, action = updates::check)
  UpdateState.Checking -> Row("Check for updates", "Looking…", ONCE_A_DAY)
  is UpdateState.UpToDate -> Row(
    "Check for updates",
    "Up to date",
    state.latest?.let { "Latest release: ${it.version}${it.published?.let { at -> ", ${ago(at, now)}" }.orEmpty()}." } ?: "No release on GitHub yet.",
    updates::check,
  )
  is UpdateState.Available -> Row(
    "Install version ${state.release.version}",
    detail = "${state.release.published?.let { "Released ${ago(it, now)}. " }.orEmpty()}The music stops while it installs; open Playarr again afterwards.",
    action = updates::install,
  )
  is UpdateState.Downloading -> Row("Downloading version ${state.release.version}", "${state.percent}%")
  is UpdateState.Allow -> Row("Allow Playarr to install updates", detail = "Once, in the TV’s settings.", action = updates::install)
  is UpdateState.Installing -> Row("Installing version ${state.release.version}", detail = "Confirm on the screen the TV shows.")
  is UpdateState.Failed -> state.release?.let { Row("Install version ${it.version}", action = updates::install) }
    ?: Row("Check again", detail = ONCE_A_DAY, action = updates::check)
}

private fun note(state: UpdateState): String? = when (state) {
  is UpdateState.Available -> state.release.notes.takeIf { it.isNotBlank() }?.let { if (it.length > 300) it.take(299).trimEnd() + "…" else it }
  is UpdateState.Allow ->
    "The TV needs to allow Playarr to install apps. If its settings didn’t open, find Playarr under Settings → Device Preferences (or Apps) → Security & restrictions → Unknown sources, turn it on, and come back."
  is UpdateState.Failed -> state.message
  else -> null
}
